/** Ambient declaration for CSS Modules, matching the vendored `styles.d.ts`. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css' {
  const content: string
  export default content
}
