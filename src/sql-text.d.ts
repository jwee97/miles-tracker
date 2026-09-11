// schema.sql and seed.sql are bundled as text by the [[rules]] entry in
// wrangler.toml, so the deployed Worker can migrate its own database.
declare module '*.sql' {
  const content: string;
  export default content;
}
