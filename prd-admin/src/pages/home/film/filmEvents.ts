/**
 * 首屏「观看完整片花」按钮与片花区块之间的约定：首屏在点击的那一拍派发这个事件，
 * 片花区块收到后在同一个手势里建好音频（浏览器只认手势里的这一下），滚过去，露出来就带声开播。
 * 用事件而不是互相 import，是为了首屏不必知道片花播放器的内部。
 */
export const FILM_PLAY_EVENT = 'map:film-play';

export function requestFilmPlay(): void {
  window.dispatchEvent(new Event(FILM_PLAY_EVENT));
}
