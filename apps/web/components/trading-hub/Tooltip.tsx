import React from 'react';

interface TooltipProps {
  text: string;
  children: React.ReactNode;
  pos?: 'top' | 'bottom' | 'left' | 'right';
  width?: 'narrow' | 'normal' | 'wide';
}

const POS_CLASSES = {
  top:    'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left:   'right-full top-1/2 -translate-y-1/2 mr-2',
  right:  'left-full top-1/2 -translate-y-1/2 ml-2',
};

const WIDTH_CLASSES = {
  narrow: 'w-40',
  normal: 'w-56',
  wide:   'w-72',
};

export const Tooltip: React.FC<TooltipProps> = ({
  text, children, pos = 'top', width = 'normal',
}) => (
  <div className="relative inline-flex group/tip">
    {children}
    <div className={`
      pointer-events-none absolute z-50 ${WIDTH_CLASSES[width]} ${POS_CLASSES[pos]}
      px-2.5 py-2 bg-slate-950 border border-slate-700 rounded-lg
      text-xs text-slate-300 leading-relaxed whitespace-normal
      opacity-0 group-hover/tip:opacity-100 transition-opacity duration-150 delay-100
      shadow-xl shadow-black/50
    `}>
      {text}
    </div>
  </div>
);
