type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type WebkitElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export function getNativeFullscreenElement(doc: Document = document): Element | null {
  const webkitDoc = doc as WebkitDocument;
  return doc.fullscreenElement ?? webkitDoc.webkitFullscreenElement ?? null;
}

/** 尝试浏览器原生全屏；iPhone WebKit 不支持普通元素全屏时返回 false，由页面层降级。 */
export async function tryEnterNativeFullscreen(element: HTMLElement): Promise<boolean> {
  try {
    if (element.requestFullscreen) {
      await element.requestFullscreen();
      return true;
    }
    const webkitRequestFullscreen = (element as WebkitElement).webkitRequestFullscreen;
    if (webkitRequestFullscreen) {
      await webkitRequestFullscreen.call(element);
      // 旧版 WebKit 的方法返回 void，fullscreenElement 要等事件循环后才更新；
      // 只要方法存在且没抛错，就交给 webkitfullscreenchange 同步状态。
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function tryExitNativeFullscreen(doc: Document = document): Promise<boolean> {
  try {
    if (doc.exitFullscreen) {
      await doc.exitFullscreen();
      return true;
    }
    const webkitExitFullscreen = (doc as WebkitDocument).webkitExitFullscreen;
    if (webkitExitFullscreen) {
      await webkitExitFullscreen.call(doc);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function subscribeNativeFullscreen(
  listener: () => void,
  doc: Document = document,
): () => void {
  doc.addEventListener('fullscreenchange', listener);
  doc.addEventListener('webkitfullscreenchange', listener);
  return () => {
    doc.removeEventListener('fullscreenchange', listener);
    doc.removeEventListener('webkitfullscreenchange', listener);
  };
}
