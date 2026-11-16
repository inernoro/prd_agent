/** Binary area partition: every rectangle preserves its share of the record total. */
export function callMapLayout<T>(items: T[], read: (item: T) => number) {
  const positive = items
    .filter((item) => read(item) > 0)
    .sort((a, b) => read(b) - read(a));
  const result: {
    item: T;
    x: number;
    y: number;
    width: number;
    height: number;
  }[] = [];
  function split(
    group: T[],
    x: number,
    y: number,
    width: number,
    height: number,
  ) {
    if (!group.length) return;
    if (group.length === 1) {
      result.push({ item: group[0], x, y, width, height });
      return;
    }
    const sum = group.reduce((value, item) => value + read(item), 0);
    let left = read(group[0]);
    let cut = 1;
    while (cut < group.length - 1 && left + read(group[cut]) / 2 < sum / 2) {
      left += read(group[cut]);
      cut++;
    }
    const ratio = left / sum;
    if (width >= height) {
      split(group.slice(0, cut), x, y, width * ratio, height);
      split(
        group.slice(cut),
        x + width * ratio,
        y,
        width * (1 - ratio),
        height,
      );
    } else {
      split(group.slice(0, cut), x, y, width, height * ratio);
      split(
        group.slice(cut),
        x,
        y + height * ratio,
        width,
        height * (1 - ratio),
      );
    }
  }
  split(positive, 0, 0, 100, 100);
  return result;
}
