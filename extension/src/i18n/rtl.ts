/**
 * RTL helper for browser extension.
 * 
 * Applies RTL classes to the document when needed.
 */

import { isRtl, loadLocale } from "./index";

export async function applyRtl() {
  const locale = await loadLocale();
  const rtl = isRtl(locale);
  
  if (rtl) {
    document.documentElement.classList.add("rtl");
    document.documentElement.setAttribute("dir", "rtl");
  } else {
    document.documentElement.classList.remove("rtl");
    document.documentElement.setAttribute("dir", "ltr");
  }
  
  return rtl;
}

export function getTooltipPosition(isRtl: boolean): "left" | "right" {
  return isRtl ? "left" : "right";
}

export function getDirection(isRtl: boolean): "ltr" | "rtl" {
  return isRtl ? "rtl" : "ltr";
}
