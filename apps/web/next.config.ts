import type { NextConfig } from "next";

const config: NextConfig = {
  // El paquete de contrato se consume como TS fuente
  transpilePackages: ["@updown/protocol"],
};

export default config;
