export type DesktopChromeProfile = {
  kind: "desktop-chrome";
  executable?: string;
  userDataDir: string;
  windowSize: { width: number; height: number };
  display?: "headless" | "headed";
  extraArgs?: string[];
  proxy?: string;
  downloadPath?: string;
};

export type AttachProfile = { kind: "attach"; cdpUrl: string; downloadPath?: string };

export type ServerPlainProfile = {
  kind: "server-plain";
  executable?: string;
  userDataDir: string;
  windowSize: { width: number; height: number };
  display: "xvfb" | "headless";
  extraArgs?: string[];
  proxy?: string;
  downloadPath?: string;
};

export type BrowserProfile = DesktopChromeProfile | ServerPlainProfile | AttachProfile;
