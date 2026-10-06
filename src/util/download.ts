import { basename, extname } from "node:path";

export function sanitizeDownloadName(input: string): string {
  let name = input.replace(/[\\/\u0000-\u001f\u007f]/gu, "").replace(/^\.+/u, "");
  name = name.replace(/[<>:"|?*]/gu, "").trim();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu.test(name)) name = "";
  if (!name) return "download";
  const extension = extname(name);
  const stem = basename(name, extension);
  return `${stem.slice(0, Math.max(1, 120 - extension.length))}${extension}`;
}
