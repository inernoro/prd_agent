/**
 * SplitText - 文字拆分入场动画 (无 GSAP 依赖版)
 * 基于 motion/react 实现的逐字/逐词入场效果
 * 灵感来自 ReactBits SplitText，但使用 Framer Motion 替代 GSAP
 * @see https://reactbits.dev/text-animations/split-text
 */
import { useEffect, useRef, useState } from 'react';
import { motion, type Transition } from 'motion/react';

interface SplitTextProps {
  text: string;
  className?: string;
  delay?: number;
  duration?: number;
  splitBy?: 'chars' | 'words';
  from?: Record<string, string | number>;
  to?: Record<string, string | number>;
  threshold?: number;
  tag?: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'p' | 'span' | 'div';
  onAnimationComplete?: () => void;
}

export default function SplitText({
  text,
  className = '',
  delay = 50,
  duration = 0.6,
  splitBy = 'chars',
  from = { opacity: 0, y: 40 },
  to = { opacity: 1, y: 0 },
  threshold = 0.1,
  tag: Tag = 'p',
  onAnimationComplete,
}: SplitTextProps) {
  const [inView, setInView] = useState(false);
  const ref = useRef<HTMLElement>(null);

  const segments = splitBy === 'words' ? text.split(' ') : text.split('');

  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setInView(true);
          observer.unobserve(ref.current as Element);
        }
      },
      { threshold },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [threshold]);

  return (
    <Tag
      ref={ref as React.RefObject<HTMLParagraphElement>}
      className={`inline-flex flex-wrap ${className}`}
      style={{ willChange: 'transform, opacity' }}
    >
      {segments.map((segment, index) => {
        const transition: Transition = {
          duration,
          delay: (index * delay) / 1000,
          ease: [0.25, 0.1, 0.25, 1],
        };

        return (
          <motion.span
            key={index}
            initial={from}
            animate={inView ? to : from}
            transition={transition}
            onAnimationComplete={
              index === segments.length - 1 ? onAnimationComplete : undefined
            }
            style={{ display: 'inline-block', willChange: 'transform, opacity' }}
          >
            {segment === ' ' ? '\u00A0' : segment}
            {splitBy === 'words' && index < segments.length - 1 && '\u00A0'}
          </motion.span>
        );
      })}
    </Tag>
  );
}
