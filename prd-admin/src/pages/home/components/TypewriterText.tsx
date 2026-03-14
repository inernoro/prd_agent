import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import DecryptedText from '@/components/reactbits/DecryptedText';

interface TypewriterTextProps {
  texts: string[];
  className?: string;
  typingSpeed?: number;
  deletingSpeed?: number;
  pauseDuration?: number;
}

export function TypewriterText({
  texts,
  className,
  typingSpeed = 100,
  pauseDuration = 2000,
}: TypewriterTextProps) {
  const [textIndex, setTextIndex] = useState(0);

  useEffect(() => {
    if (!texts || texts.length <= 1) return;
    const interval = setInterval(() => {
      setTextIndex((prev) => (prev + 1) % texts.length);
    }, pauseDuration + 1500); // 预留额外的解密动画时间
    return () => clearInterval(interval);
  }, [texts, pauseDuration]);

  if (!texts || texts.length === 0) return null;

  return (
    <span className={cn('inline-block', className)}>
      <DecryptedText
        key={textIndex}
        text={texts[textIndex]}
        speed={typingSpeed < 50 ? 50 : typingSpeed}
        maxIterations={15}
        sequential={true}
        revealDirection="start"
        animateOn="view"
      />
    </span>
  );
}
