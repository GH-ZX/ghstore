/** Hand-drawn icons from the GH. identity (no icon library). */
import type { ReactNode } from "react";

interface P {
  size?: number;
  active?: boolean;
}

function Svg({ size = 24, children }: { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const fillFor = (a?: boolean) => (a ? "var(--accent-text)" : "none");
const strokeFor = (a?: boolean) => (a ? "var(--accent-text)" : "currentColor");

export const StoreIcon = ({ size, active }: P) => (
  <Svg size={size}>
    <path d="M5 8h14l-1.2 12H6.2z" fill={fillFor(active)} stroke={strokeFor(active)} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M9 8a3 3 0 0 1 6 0" fill="none" stroke={strokeFor(active)} strokeWidth="1.6" strokeLinecap="round" />
  </Svg>
);

export const OrdersIcon = ({ size, active }: P) => (
  <Svg size={size}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" fill={fillFor(active)} stroke={strokeFor(active)} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M9 8h6M9 12h6" stroke={active ? "var(--surface)" : "currentColor"} strokeWidth="1.6" strokeLinecap="round" />
  </Svg>
);

export const WalletIcon = ({ size, active }: P) => (
  <Svg size={size}>
    <path d="M3 8a2 2 0 0 1 2-2h14v13H5a2 2 0 0 1-2-2z" fill={fillFor(active)} stroke={strokeFor(active)} strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M14 11h7v5h-7a2.5 2.5 0 0 1 0-5z" fill="var(--bg)" stroke={strokeFor(active)} strokeWidth="1.6" strokeLinejoin="round" />
  </Svg>
);

export const ProfileIcon = ({ size, active }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="8" r="4" fill={fillFor(active)} stroke={strokeFor(active)} strokeWidth="1.6" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6z" fill={fillFor(active)} stroke={strokeFor(active)} strokeWidth="1.6" strokeLinejoin="round" />
  </Svg>
);

export const SearchIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.9" />
    <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
  </Svg>
);

export const CloseIcon = ({ size = 16 }: P) => (
  <Svg size={size}>
    <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </Svg>
);

export const CheckIcon = ({ size = 18 }: P) => (
  <Svg size={size}>
    <path d="m5 12 5 5 9-10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const PlusIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
  </Svg>
);

export const BoltIcon = ({ size = 12 }: P) => (
  <Svg size={size}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7z" fill="var(--good)" />
  </Svg>
);

/** A package's warranty. */
export const ShieldIcon = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M12 3 5 6v5.5c0 4.3 2.9 8 7 9.5 4.1-1.5 7-5.2 7-9.5V6z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="m9 12 2.2 2.2L15.5 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const ShareIcon = ({ size = 18 }: P) => (
  <Svg size={size}>
    <path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const GiftIcon = ({ size = 22 }: P) => (
  <Svg size={size}>
    <path d="M4 11h16v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8ZM3 7h18v4H3zM12 7v14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M12 7c-1.5-3.5-5-3.5-5-1.2C7 7 9 7 12 7Zm0 0c1.5-3.5 5-3.5 5-1.2C17 7 15 7 12 7Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
  </Svg>
);

export const ChevronIcon = ({ size = 18 }: P) => (
  <Svg size={size}>
    <path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flip-rtl" />
  </Svg>
);

export const ArrowInIcon = ({ size = 18 }: P) => (
  <Svg size={size}>
    <path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const ArrowOutIcon = ({ size = 18 }: P) => (
  <Svg size={size}>
    <path d="M12 19V5M6 11l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const AdminIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="M12 3l8 4v5c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V7z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
    <path d="m9 12 2 2 4-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

/** Payment method marks, drawn for the identity (not the providers' logos). */
export function MethodMark({ method }: { method: string }) {
  if (method === "sam")
    return (
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <rect x="10" y="3" width="20" height="34" rx="5" fill="#16A34A" />
        <rect x="13" y="7" width="14" height="21" rx="2" fill="#DCFCE7" />
        <circle cx="20" cy="17.5" r="5" fill="#16A34A" />
        <path d="M18.5 17.5h3M20 16v3" stroke="#DCFCE7" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="20" cy="32.5" r="1.6" fill="#DCFCE7" />
      </svg>
    );
  if (method === "nowpayments")
    return (
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="19" cy="19" r="16" fill="#14B8A6" />
        <path d="M12 12h14M19 12v15M13.5 17.5c3 1.2 8 1.2 11 0" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" fill="none" />
        <circle cx="31" cy="31" r="8" fill="#FACC15" />
        <path d="M32.5 25.5 28 32h3.2l-1.2 4.5 4.6-6.5h-3.2z" fill="#1F2937" />
      </svg>
    );
  if (method === "bep20")
    return (
      <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
        <circle cx="19" cy="19" r="16" fill="#0F766E" />
        <path d="M12 12h14M19 12v15M13.5 17.5c3 1.2 8 1.2 11 0" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" fill="none" />
        <circle cx="31" cy="31" r="8" fill="#F59E0B" />
        <path d="M28 34 34 28M30 28h4v4" stroke="#1F2937" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </svg>
    );
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" aria-hidden="true">
      <path d="M20 3.5l4.9 10 11 1.6-8 7.8 1.9 11L20 28.7l-9.8 5.2 1.9-11-8-7.8 11-1.6z" fill="#F5B301" />
      <path d="M20 9.5l3 6.1 6.7 1-4.9 4.7 1.2 6.7-6-3.2-6 3.2 1.2-6.7-4.9-4.7 6.7-1z" fill="#FFD84D" />
    </svg>
  );
}

// ───────────────────────────── category icons (Admin → Home picks one per category)

const line = { fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const CATEGORY_PATHS: Record<string, ReactNode> = {
  game: (
    <>
      <path {...line} d="M7.5 8h9a4.5 4.5 0 0 1 4.3 5.8l-1 3.3a2.2 2.2 0 0 1-3.7.9L14.5 16h-5l-1.6 2a2.2 2.2 0 0 1-3.7-.9l-1-3.3A4.5 4.5 0 0 1 7.5 8z" />
      <path {...line} d="M8 11v3M6.5 12.5h3" />
      <circle cx="15.5" cy="11.5" r="1" fill="currentColor" />
      <circle cx="17.5" cy="13.5" r="1" fill="currentColor" />
    </>
  ),
  gift: (
    <>
      <path {...line} d="M4 10h16v3H4zM5.5 13h13v7h-13zM12 10v10" />
      <path {...line} d="M12 10c-1.5-3-5-3.5-5-1.2C7 10 9 10 12 10zm0 0c1.5-3 5-3.5 5-1.2 0 1.2-2 1.2-5 1.2z" />
    </>
  ),
  spark: (
    <>
      <path {...line} d="M11 3.5l1.6 4.9a3 3 0 0 0 1.9 1.9L19.5 12l-5 1.7a3 3 0 0 0-1.9 1.9L11 20.5l-1.6-4.9a3 3 0 0 0-1.9-1.9L2.5 12l5-1.7a3 3 0 0 0 1.9-1.9z" />
      <path {...line} d="M18.5 3v4M16.5 5h4" />
    </>
  ),
  play: (
    <>
      <rect {...line} x="3" y="5" width="18" height="14" rx="4" />
      <path {...line} d="M10 9.2v5.6l4.8-2.8z" />
    </>
  ),
  palette: (
    <>
      <path {...line} d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.8 0-1.3-1-1.7-1-2.9 0-1 .8-1.8 1.8-1.8H17a3.5 3.5 0 0 0 3.5-3.5c0-4-3.8-7-8.5-7z" />
      <circle cx="8" cy="11" r="1.1" fill="currentColor" />
      <circle cx="10.5" cy="7.5" r="1.1" fill="currentColor" />
      <circle cx="14.8" cy="8" r="1.1" fill="currentColor" />
    </>
  ),
  briefcase: (
    <>
      <rect {...line} x="3.5" y="7" width="17" height="12" rx="2.5" />
      <path {...line} d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17M11 12.5v1.5h2v-1.5" />
    </>
  ),
  shield: (
    <>
      <path {...line} d="M12 3l7 2.8v5.4c0 4.4-3 8-7 9.8-4-1.8-7-5.4-7-9.8V5.8z" />
      <path {...line} d="M9 12l2 2 4-4" />
    </>
  ),
  phone: (
    <>
      <rect {...line} x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path {...line} d="M10.5 18.5h3" />
    </>
  ),
  bolt: <path {...line} d="M13 2.5L5 13.5h6l-1 8 8-11h-6z" />,
  code: <path {...line} d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14" />,
  music: (
    <>
      <path {...line} d="M9 17.5V5.5l10-2v12" />
      <circle {...line} cx="6.5" cy="17.5" r="2.5" />
      <circle {...line} cx="16.5" cy="15.5" r="2.5" />
    </>
  ),
  book: <path {...line} d="M5 4.5h10.5A2.5 2.5 0 0 1 18 7v13H7.5A2.5 2.5 0 0 1 5 17.5zM5 17.5A2.5 2.5 0 0 1 7.5 15H18M9 8.5h5" />,
  card: (
    <>
      <rect {...line} x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path {...line} d="M3 10h18M7 14.5h3" />
    </>
  ),
  globe: (
    <>
      <circle {...line} cx="12" cy="12" r="8.5" />
      <path {...line} d="M3.5 12h17M12 3.5c2.4 2.5 3.5 5.3 3.5 8.5s-1.1 6-3.5 8.5c-2.4-2.5-3.5-5.3-3.5-8.5S9.6 6 12 3.5z" />
    </>
  ),
  star: <path {...line} d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />,
  cart: (
    <>
      <path {...line} d="M3 4.5h2.2l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h8.4a1.5 1.5 0 0 0 1.5-1.1l1.4-6.3H6.2" />
      <circle cx="9.5" cy="19.5" r="1.3" fill="currentColor" />
      <circle cx="17" cy="19.5" r="1.3" fill="currentColor" />
    </>
  ),
  chat: <path {...line} d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17h0A2.5 2.5 0 0 1 4 14.5z" />,
  cloud: <path {...line} d="M7.5 18.5a4.5 4.5 0 0 1-.6-9 5.5 5.5 0 0 1 10.6 1.4A3.8 3.8 0 0 1 17 18.5z" />,
};

/** The names an owner can pick for a category (same list as CATEGORY_ICON_NAMES in packages/api). */
export const CATEGORY_ICON_NAMES = Object.keys(CATEGORY_PATHS);

/** A category's icon; categories without one get a neutral tile mark. */
export function CategoryIcon({ name, size = 24 }: { name?: string | null; size?: number }) {
  const art = (name && CATEGORY_PATHS[name]) || CATEGORY_PATHS.star;
  return <Svg size={size}>{art}</Svg>;
}

export const ArrowIcon = ({ size = 18 }: P) => (
  <Svg size={size}>
    <path {...line} d="M5 12h14M13 6l6 6-6 6" />
  </Svg>
);

/* ───────────── admin sections (stroke icons, 20px by default) */

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const OverviewIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="2" {...stroke} />
    <rect x="13.5" y="3.5" width="7" height="4.5" rx="2" {...stroke} />
    <rect x="13.5" y="11" width="7" height="9.5" rx="2" {...stroke} />
    <rect x="3.5" y="13.5" width="7" height="7" rx="2" {...stroke} />
  </Svg>
);

export const ChartIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="M4 20.5h16" {...stroke} />
    <path d="M6.5 17v-4M11 17V9.5M15.5 17v-6M20 17V5.5" {...stroke} />
    <path d="m4.5 10 5-4.5 4 3 6-5" {...stroke} />
  </Svg>
);

export const TopupIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <rect x="3" y="6" width="18" height="13" rx="3" {...stroke} />
    <path d="M12 9.5v6M9 12.5h6M7 3.5h10" {...stroke} />
  </Svg>
);

export const ReceiptIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2z" {...stroke} />
    <path d="M9 8.5h6M9 12h6" {...stroke} />
  </Svg>
);

export const BoxIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" {...stroke} />
    <path d="m4 7.5 8 4.5 8-4.5M12 12v9" {...stroke} />
  </Svg>
);

export const HomeIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="M4 10.5 12 4l8 6.5V19a1.5 1.5 0 0 1-1.5 1.5H15V15h-6v5.5H5.5A1.5 1.5 0 0 1 4 19z" {...stroke} />
  </Svg>
);

export const TicketIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5V10a2 2 0 0 0 0 4v2.5A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5V14a2 2 0 0 0 0-4z" {...stroke} />
    <path d="M14 6v12" {...stroke} strokeDasharray="2 2.5" />
  </Svg>
);

export const MegaphoneIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="M4 10v4a1 1 0 0 0 1 1h2l8 4.5V4.5L7 9H5a1 1 0 0 0-1 1z" {...stroke} />
    <path d="M18.5 9a4 4 0 0 1 0 6M7.5 15l1 4.5" {...stroke} />
  </Svg>
);

export const TruckIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="M3 6.5h11v9.5H3zM14 9.5h3.5L21 13v3h-7z" {...stroke} />
    <circle cx="7" cy="17.5" r="1.8" {...stroke} />
    <circle cx="17" cy="17.5" r="1.8" {...stroke} />
  </Svg>
);

export const UsersIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <circle cx="9" cy="8.5" r="3.2" {...stroke} />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14.2A5.5 5.5 0 0 1 20.5 19" {...stroke} />
  </Svg>
);

export const GearIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="3" {...stroke} />
    <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" {...stroke} />
  </Svg>
);

export const ExitIcon = ({ size = 20 }: P) => (
  <Svg size={size}>
    <path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14M10 12h10M16.5 8.5 20 12l-3.5 3.5" {...stroke} />
  </Svg>
);
