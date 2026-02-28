/**
 * DecryptedText - ReactBits 风格的解密文字动画组件
 * 文字从乱码逐渐解密为真实内容
 * @see https://reactbits.dev/text-animations/decrypted-text
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { motion } from 'motion/react';

interface DecryptedTextProps {
  text: string;
  speed?: number;
  maxIterations?: number;
  sequential?: boolean;
  revealDirection?: 'start' | 'end' | 'center';
  useOriginalCharsOnly?: boolean;
  characters?: string;
  className?: string;
  encryptedClassName?: string;
  parentClassName?: string;
  animateOn?: 'view' | 'hover' | 'both';
}

export default function DecryptedText({
  text,
  speed = 50,
  maxIterations = 10,
  sequential = false,
  revealDirection = 'start',
  useOriginalCharsOnly = false,
  characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!@#$%^&*()_+',
  className = '',
  parentClassName = '',
  encryptedClassName = '',
  animateOn = 'view',
}: DecryptedTextProps) {
  const [displayText, setDisplayText] = useState(text);
  const [, setIsHovering] = useState(false);
  const [isScrambling, setIsScrambling] = useState(false);
  const [revealedIndices, setRevealedIndices] = useState<Set<number>>(new Set());
  const [hasAnimated, setHasAnimated] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);

  const getRandomChar = useCallback(() => {
    if (useOriginalCharsOnly) {
      return text[Math.floor(Math.random() * text.length)];
    }
    return characters[Math.floor(Math.random() * characters.length)];
  }, [text, characters, useOriginalCharsOnly]);

  const getNextIndex = useCallback(
    (currentRevealed: Set<number>): number => {
      const unrevealed = Array.from({ length: text.length }, (_, i) => i).filter(
        (i) => !currentRevealed.has(i),
      );
      if (unrevealed.length === 0) return -1;
      if (revealDirection === 'start') return unrevealed[0];
      if (revealDirection === 'end') return unrevealed[unrevealed.length - 1];
      // center
      return unrevealed[Math.floor(unrevealed.length / 2)];
    },
    [text.length, revealDirection],
  );

  useEffect(() => {
    if (!isScrambling) return;
    let iteration = 0;
    const revealed = new Set(revealedIndices);

    const interval = setInterval(() => {
      if (sequential) {
        const nextIdx = getNextIndex(revealed);
        if (nextIdx === -1) {
          clearInterval(interval);
          setIsScrambling(false);
          setDisplayText(text);
          setHasAnimated(true);
          return;
        }

        if (iteration >= maxIterations) {
          revealed.add(nextIdx);
          setRevealedIndices(new Set(revealed));
          iteration = 0;
        }
      } else {
        if (iteration >= maxIterations) {
          clearInterval(interval);
          setIsScrambling(false);
          setDisplayText(text);
          setHasAnimated(true);
          return;
        }
      }

      setDisplayText(
        text
          .split('')
          .map((char, idx) => {
            if (char === ' ') return ' ';
            if (revealed.has(idx)) return text[idx];
            return getRandomChar();
          })
          .join(''),
      );

      iteration++;
    }, speed);

    return () => clearInterval(interval);
  }, [isScrambling, text, speed, maxIterations, sequential, getRandomChar, getNextIndex, revealedIndices]);

  const startScramble = useCallback(() => {
    if (isScrambling) return;
    setRevealedIndices(new Set());
    setIsScrambling(true);
  }, [isScrambling]);

  // Intersection Observer for view-based animation
  useEffect(() => {
    if (animateOn !== 'view' && animateOn !== 'both') return;
    if (hasAnimated) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasAnimated) {
          startScramble();
        }
      },
      { threshold: 0.1 },
    );

    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [animateOn, hasAnimated, startScramble]);

  const hoverHandlers =
    animateOn === 'hover' || animateOn === 'both'
      ? {
          onMouseEnter: () => {
            setIsHovering(true);
            startScramble();
          },
          onMouseLeave: () => setIsHovering(false),
        }
      : {};

  return (
    <motion.span
      ref={containerRef}
      className={`inline-block whitespace-pre-wrap ${parentClassName}`}
      {...hoverHandlers}
    >
      {/* Screen reader text */}
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {displayText.split('').map((char, i) => {
          const isRevealed = revealedIndices.has(i) || (!isScrambling && hasAnimated);
          return (
            <span
              key={i}
              className={isRevealed ? className : `${className} ${encryptedClassName}`}
            >
              {char}
            </span>
          );
        })}
      </span>
    </motion.span>
  );
}
