import { useState, useEffect, useRef, useCallback } from 'react';

export function useCountUp(target: number, duration: number = 2000) {
  const [count, setCount] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  
  const observerRef = useRef<IntersectionObserver | null>(null);
  const currentCountRef = useRef(0);

  const elementRef = useCallback((node: Element | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }

    if (node) {
      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            setIsVisible(true);
            observer.disconnect();
          }
        },
        { threshold: 0.1 }
      );
      observer.observe(node);
      observerRef.current = observer;
    }
  }, []);

  // Cleanup observer on unmount
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    if (!isVisible) return;

    const startValue = currentCountRef.current;
    let startTime: number | null = null;
    let animationFrame: number;
    let lastUpdateTime = performance.now();

    const animate = (currentTime: number) => {
      if (!startTime) startTime = currentTime;
      const progress = Math.min((currentTime - startTime) / duration, 1);
      
      // Easing function: easeOutQuart
      const ease = 1 - Math.pow(1 - progress, 4);
      const nextCount = Math.floor(startValue + ease * (target - startValue));
      
      // Throttle React commits to ~30fps (every 32ms) to avoid a commit per frame
      if (
        nextCount !== currentCountRef.current && 
        (currentTime - lastUpdateTime >= 32 || progress === 1)
      ) {
        currentCountRef.current = nextCount;
        setCount(nextCount);
        lastUpdateTime = currentTime;
      }
      
      if (progress < 1) {
        animationFrame = requestAnimationFrame(animate);
      }
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [isVisible, target, duration]);

  return { count, elementRef };
}
