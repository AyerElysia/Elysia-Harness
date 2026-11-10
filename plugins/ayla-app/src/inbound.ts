/**
 * Ayla inbound frames as delivered events.
 *
 * A frame becomes one event only when every part can be presented. Images
 * arrive as a media id: the same JWT signs a short-lived GET URL, the bytes are
 * downloaded, and DSH attachment admission stores them before the event is
 * queued. A part that cannot be admitted makes the whole message undeliverable
 * and the caller must not ack it, so Ayla redelivers instead of the model
 * silently receiving a shortened message (REQUIREMENTS.zh.md §7.1).
 * @module @elysia/ayla-app/inbound
 */

import type { AdmittedPromptContentPart, AttachmentAdmissionPart, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { formatAylaConversation } from './conversation.ts'
import type { AylaInboundPart, InboundMessagePayload } from './protocol.ts'

/** Durable text or image content retained by the pending queue. */
export type AylaInboundContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }

/**
 * One fully admitted inbound event.
 *
 * Field names match the conscious mind's event so this value can be handed to
 * its pending queue without importing that package (REQUIREMENTS.zh.md §2 C1).
 */
export interface InboundEvent {
  channel: string
  conversation: string
  messageId: string
  senderId: string
  senderName: string
  content: readonly AylaInboundContentPart[]
}

/** The channel name every Ayla event carries. */
export const AYLA_INBOUND_CHANNEL = 'ayla'

/** Image formats the attachment path accepts. */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** A part, or a whole message, that cannot be delivered. */
export class AylaInboundRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AylaInboundRejected'
  }
}

/** Byte source for one signed media URL. */
export type AylaMediaFetch = (url: string) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>

/** Admission port; the harness attachment store satisfies it. */
export interface AylaAttachmentAdmission {
  readonly imageLimits: { readonly maxImageBytes: number; readonly maxImagesPerMessage: number }
  admitPromptContent(content: readonly AttachmentAdmissionPart[]): Promise<AdmittedPromptContentPart[]>
}

/** Collaborators one inbound message needs. */
export interface AylaInboundDeps {
  /** Signs `media_id` into a short-lived GET URL with the account token. */
  signMedia(mediaId: string): Promise<string>
  /** Downloads the signed URL. */
  fetchMedia: AylaMediaFetch
  /** Durable attachment admission. */
  attachments: AylaAttachmentAdmission
}

function imageMediaType(declared: string): ImageMediaType {
  const normalized = declared.trim().toLowerCase()
  const match = IMAGE_MEDIA_TYPES.find(type => type === normalized)
  if (match === undefined) {
    throw new AylaInboundRejected(`不支持的图片类型: ${JSON.stringify(declared)}`)
  }
  return match
}

/**
 * Read an image's MIME type from its magic bytes.
 * Ayla's media table knows the type server-side, so a frame may omit it; the
 * bytes are the authoritative answer either way.
 * @param data - the downloaded object.
 * @returns the media type, or undefined when the bytes are not a known image.
 */
function sniffImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  if (data.length >= 6
    && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x38) return 'image/gif'
  return undefined
}

/**
 * Sign, download, and admit one image.
 * @param mediaId - Ayla media id from the frame.
 * @param declared - media type Ayla declared for that object.
 * @param deps - signer, downloader, and attachment store.
 * @returns the admission part carrying the encoded bytes.
 */
async function admitImage(
  mediaId: string,
  declared: string | undefined,
  deps: AylaInboundDeps,
): Promise<AttachmentAdmissionPart> {
  const url = await deps.signMedia(mediaId)
  if (url.length === 0) throw new AylaInboundRejected(`媒体 ${mediaId} 未返回下载地址`)
  const response = await deps.fetchMedia(url)
  if (!response.ok) {
    throw new AylaInboundRejected(`媒体 ${mediaId} 下载失败: HTTP ${String(response.status)}`)
  }
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.byteLength === 0) throw new AylaInboundRejected(`媒体 ${mediaId} 是空文件`)
  // Checked here as well as in admission so an oversized object is refused
  // before it is held in memory as base64.
  if (data.byteLength > deps.attachments.imageLimits.maxImageBytes) {
    throw new AylaInboundRejected(`媒体 ${mediaId} 超过单图字节上限`)
  }
  // Declared type wins when Ayla sent one; otherwise the bytes decide, so a
  // frame that omits media_type still admits a real image instead of failing.
  const mediaType = declared === undefined
    ? sniffImageMediaType(data)
    : imageMediaType(declared)
  if (mediaType === undefined) {
    throw new AylaInboundRejected(`媒体 ${mediaId} 不是可识别的图片格式`)
  }
  return { type: 'image', mediaType, data: Buffer.from(data).toString('base64') }
}

/**
 * Turn one parsed inbound frame into an admitted event.
 *
 * Every failure throws {@link AylaInboundRejected} or the admission error;
 * the caller must then neither queue the event nor ack the frame.
 * @param message - the frame's message payload.
 * @param deps - signer, downloader, and attachment store.
 * @returns the event to queue.
 */
export async function prepareInboundEvent(
  message: InboundMessagePayload,
  deps: AylaInboundDeps,
): Promise<InboundEvent> {
  const images = message.parts.filter((part: AylaInboundPart) => part.type === 'image')
  if (images.length > deps.attachments.imageLimits.maxImagesPerMessage) {
    throw new AylaInboundRejected(
      `消息 ${message.id} 图片数 ${String(images.length)} 超过上限 ${String(deps.attachments.imageLimits.maxImagesPerMessage)}`,
    )
  }
  const input: AttachmentAdmissionPart[] = []
  for (const part of message.parts) {
    input.push(part.type === 'text'
      ? { type: 'text', text: part.text }
      : await admitImage(part.media_id, part.media_type, deps))
  }
  const admitted = await deps.attachments.admitPromptContent(input)
  const content: AylaInboundContentPart[] = []
  for (const part of admitted) {
    if (part.type === 'file') {
      throw new AylaInboundRejected(`消息 ${message.id} 的图片准入意外返回文件附件`)
    }
    content.push(part)
  }
  return {
    channel: AYLA_INBOUND_CHANNEL,
    conversation: formatAylaConversation({ kind: message.conversation_type, id: message.conversation_id }),
    messageId: message.id,
    senderId: message.sender_id,
    senderName: message.sender_name,
    content,
  }
}

/**
 * Render the text of one event, for logs.
 * @param message - an admitted event.
 * @returns its text parts joined in order.
 */
export function inboundEventText(message: InboundEvent): string {
  return message.content
    .filter((part): part is { readonly type: 'text'; readonly text: string } => part.type === 'text')
    .map(part => part.text)
    .join('')
}
