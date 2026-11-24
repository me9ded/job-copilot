import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icon = {
  Form: (p: IconProps) => (
    <Svg {...p}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h4" />
    </Svg>
  ),
  Target: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 12h.01" />
    </Svg>
  ),
  Compass: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2 5-5 2 2-5z" />
    </Svg>
  ),
  Bookmark: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7 4h10v16l-5-3.5L7 20z" />
    </Svg>
  ),
  Columns: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="4" width="5" height="16" rx="1.5" />
      <rect x="10.5" y="4" width="5" height="11" rx="1.5" />
      <rect x="17.5" y="4" width="3" height="7" rx="1.2" />
    </Svg>
  ),
  Doc: (p: IconProps) => (
    <Svg {...p}>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4M10 12h5M10 16h5" />
    </Svg>
  ),
  Chat: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 5h14v10H10l-4 4v-4H5z" />
    </Svg>
  ),
  Gear: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </Svg>
  ),
  Search: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Svg>
  ),
  External: (p: IconProps) => (
    <Svg {...p}>
      <path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5H5V6h5" />
    </Svg>
  ),
  X: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  ),
  Check: (p: IconProps) => (
    <Svg {...p}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </Svg>
  ),
  Plus: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  Trash: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l1 13h9l1-13" />
    </Svg>
  ),
  Download: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" />
    </Svg>
  ),
  Upload: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19.5h14" />
    </Svg>
  ),
  Refresh: (p: IconProps) => (
    <Svg {...p}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />
    </Svg>
  ),
  Alert: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </Svg>
  ),
  Info: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </Svg>
  ),
  Edit: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4.5 19.5l1-4L15.5 5.5l3 3-10 10z" />
      <path d="M13.5 7.5l3 3" />
    </Svg>
  ),
  User: (p: IconProps) => (
    <Svg {...p}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c1-4 4-5.5 7-5.5s6 1.5 7 5.5" />
    </Svg>
  ),
  Spark: (p: IconProps) => (
    <Svg {...p}>
      <path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z" />
    </Svg>
  ),
  Panel: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15" />
    </Svg>
  ),
  ChevronDown: (p: IconProps) => (
    <Svg {...p}>
      <path d="M6.5 9.5L12 15l5.5-5.5" />
    </Svg>
  ),
  ArrowLeft: (p: IconProps) => (
    <Svg {...p}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </Svg>
  ),
  Clipboard: (p: IconProps) => (
    <Svg {...p}>
      <rect x="6" y="5" width="12" height="16" rx="2" />
      <path d="M9.5 5V3.5h5V5" />
    </Svg>
  ),
  Table: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="5" width="17" height="14" rx="1.5" />
      <path d="M3.5 10h17M3.5 14.5h17M9.5 10v9" />
    </Svg>
  ),
  Home: (p: IconProps) => (
    <Svg {...p}>
      <path d="M4 11l8-6.5 8 6.5" />
      <path d="M6 9.5V20h12V9.5M10 20v-5h4v5" />
    </Svg>
  ),
  Briefcase: (p: IconProps) => (
    <Svg {...p}>
      <rect x="3.5" y="7" width="17" height="12.5" rx="2" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17" />
    </Svg>
  ),
};
