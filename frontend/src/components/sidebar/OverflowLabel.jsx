import { useEffect, useRef, useState } from 'react';

// Text label that only gets a hover tooltip when it actually overflows its
// container — used across the sidebar (session dropdown, "Sessions for:"
// header, archived-session names).
export default function OverflowLabel({ text, className }) {
  const ref = useRef(null);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (el) setOverflows(el.scrollWidth > el.clientWidth);
  }, [text]);

  return (
    <span ref={ref} className={className} title={overflows ? text : undefined}>
      {text}
    </span>
  );
}
