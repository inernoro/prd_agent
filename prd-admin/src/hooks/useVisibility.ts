import { useEffect, useState } from 'react';

export function useVisibility(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const onChange = () => setVisible(!document.hidden);
    onChange();
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return visible;
}


