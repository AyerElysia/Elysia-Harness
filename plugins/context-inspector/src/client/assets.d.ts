/** Browser styles are compiled by DSH's official client bundle preset. */
declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}
