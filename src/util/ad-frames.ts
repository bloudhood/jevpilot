export const adFrameRules = {
  namePrefixes: ["google_ads_iframe_", "aswift_"],
  names: [
    "google_ads_top_frame",
    "__tcfapiLocator",
    "__uspapiLocator",
    "__gppLocator",
    "__cmpLocator",
  ],
  hosts: [
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "googletagservices.com",
    "amazon-adsystem.com",
    "adnxs.com",
    "criteo.com",
    "criteo.net",
    "pubmatic.com",
    "rubiconproject.com",
    "openx.net",
    "casalemedia.com",
    "media.net",
    "adsrvr.org",
    "adthrive.com",
    "inmobi.com",
    "presage.io",
    "taboola.com",
    "outbrain.com",
    "teads.tv",
    "3lift.com",
    "smartadserver.com",
    "moatads.com",
    "doubleverify.com",
    "adsafeprotected.com",
    "pos.baidu.com",
    "cpro.baidu.com",
    "tanx.com",
    "gdt.qq.com",
    "mediav.com",
    "ipinyou.com",
  ],
  exactHosts: ["adservice.google.com"],
};

export function isAdFrame(name: string | undefined, url: string | undefined): boolean {
  if (
    name &&
    (adFrameRules.names.includes(name) ||
      adFrameRules.namePrefixes.some((prefix) => name.startsWith(prefix)))
  )
    return true;
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      adFrameRules.exactHosts.includes(host) ||
      adFrameRules.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
    );
  } catch {
    return false;
  }
}
