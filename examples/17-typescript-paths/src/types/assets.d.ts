// `package.esbuild.loader: {".html": "text"}` turns imported .html files into strings.
declare module "*.html" {
  const content: string;
  export default content;
}
