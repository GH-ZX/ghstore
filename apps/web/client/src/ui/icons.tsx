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
