/// <reference types="vite/client" />

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*?url" {
  const src: string;
  export default src;
}
