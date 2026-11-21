/**
 * The live surface uses the deployment-owned Elysia Breeze reference voice.
 * Guest speech requires a separately authorised voice adapter; it must never
 * silently reuse Elysia's voice under another speaker's name.
 */
export const DEFAULT_VOICE = 'elysia-breeze';
export const GUEST_VOICE = 'guest-voice-unconfigured';
