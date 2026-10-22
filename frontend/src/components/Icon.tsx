import type { ReactNode } from "react";


const PATHS = {
  tables: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  dashboard: <><path d="M4 13a8 8 0 1 1 16 0" /><path d="m12 13 4-4" /><path d="M4 13h2M18 13h2" /></>,
  orders: <><path d="M7 4.5h10a2 2 0 0 1 2 2V21l-3-2-2 2-2-2-2 2-2-2-3 2V6.5a2 2 0 0 1 2-2Z" /><path d="M9 9h6M9 13h6" /></>,
  money: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6.5 9.5v.01M17.5 14.5v.01" /></>,
  kitchen: <><path d="M5 12h14l-1.4 7.5a1 1 0 0 1-1 .8H7.4a1 1 0 0 1-1-.8L5 12Z" /><path d="M8 9c0-1.5 1-1.5 1-3M12 9c0-1.5 1-1.5 1-3M16 9c0-1.5 1-1.5 1-3" /></>,
  flame: <><path d="M12 21c4 0 6.5-2.6 6.5-6.2 0-2.8-1.5-4.8-4.2-7.6-.2 2.2-1 3.4-2.5 4.4C11.3 8 9.8 5.4 8.6 3c-.2 3.9-3.100 6.400-3.100 11.800C5.500 18.400 8 21 12 21Z" /></>,
  purchases: <><path d="M6 6h13l-1.500 8h-10L6 6Zm0 0-.7-2.500H3" /><circle cx="9" cy="19" r="1.200" /><circle cx="16" cy="19" r="1.200" /></>,
  reports: <><path d="M4 20V4M4 20h16" /><path d="M8 16v-4M12 16V8M16 16v-6" /></>,
  history: <><path d="M3.500 12a8.500 8.500 0 1 0 2.600-6.100L3.500 8.500" /><path d="M3.500 4v4.500H8M12 8v4.500l3 1.800" /></>,
  menu: <><path d="M7 3v8a2 2 0 0 0 2 2v8M7 3v5M11 3v5M15 21V3c2.500 1.500 3.500 4 3.500 7H15" /></>,
  users: <><circle cx="9" cy="8" r="3.200" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5.200a3.200 3.200 0 0 1 0 5.600M18 14.500a6 6 0 0 1 3 5.500" /></>,
  shift: <><circle cx="12" cy="12" r="8.500" /><path d="M12 7.500V12l3 2" /></>,
  more: <><circle cx="5" cy="12" r="1.300" /><circle cx="12" cy="12" r="1.300" /><circle cx="19" cy="12" r="1.300" /></>,
  bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
  logout: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" /></>,
  search: <><circle cx="11" cy="11" r="6.500" /><path d="m20 20-4.200-4.200" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  minus: <><path d="M5 12h14" /></>,
  check: <><path d="m5 12.500 4.500 4.500L19 7.500" /></>,
  x: <><path d="M6 6l12 12M18 6 6 18" /></>,
  clock: <><circle cx="12" cy="12" r="8.500" /><path d="M12 7.500V12l3 2" /></>,
  chair: <><path d="M7 3h10v8H7zM6 11h12M8 11v10M16 11v10" /></>,
  wifiOff: <><path d="M3 3l18 18M8.500 16.500a5 5 0 0 1 7 0M5 13a10 10 0 0 1 3.500-2M12 20h.01M19 13a10 10 0 0 0-6-2.900" /></>,
  wifi: <><path d="M5 12.500a10 10 0 0 1 14 0M8.500 16a5 5 0 0 1 7 0M12 20h.01" /></>,
  cloud: <><path d="M7 18a4.500 4.500 0 1 1 .8-8.900A6 6 0 0 1 19 11.500 3.300 3.300 0 0 1 18 18H7Z" /></>,
  alert: <><path d="M12 3.500 2.500 20h19L12 3.500Z" /><path d="M12 10v4.500M12 17.500v.01" /></>,
  refresh: <><path d="M20 12a8 8 0 1 1-2.400-5.700L20 8.500" /><path d="M20 4v4.500h-4.500" /></>,
  filter: <><path d="M4 6h16M7 12h10M10 18h4" /></>,
  edit: <><path d="M4 20h4L19 9a2.800 2.800 0 0 0-4-4L4 16v4Z" /><path d="m13.500 6.500 4 4" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  arrowLeft: <><path d="M19 12H5M11 6l-6 6 6 6" /></>,
  chevronRight: <><path d="m9 6 6 6-6 6" /></>,
  chevronDown: <><path d="m6 9 6 6 6-6" /></>,
  user: <><circle cx="12" cy="8" r="3.500" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  card: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h3" /></>,
  ban: <><circle cx="12" cy="12" r="8.500" /><path d="m6 6 12 12" /></>,
  send: <><path d="m21 3-9 18-2.500-7.500L3 11l18-8Z" /><path d="m9.500 13.500 5-5" /></>,
  note: <><path d="M5 4h14v12l-4 4H5V4Z" /><path d="M14 20v-4h5M8 9h8M8 13h4" /></>,
  grip: <><circle cx="9" cy="6" r="1" /><circle cx="15" cy="6" r="1" /><circle cx="9" cy="12" r="1" /><circle cx="15" cy="12" r="1" /><circle cx="9" cy="18" r="1" /><circle cx="15" cy="18" r="1" /></>,
  arrowUp: <><path d="M12 19V5M6 11l6-6 6 6" /></>,
  arrowDown: <><path d="M12 5v14M6 13l6 6 6-6" /></>,
  play: <><path d="M7 4.500v15l12-7.500L7 4.500Z" /></>,
  hourglass: <><path d="M6 3h12M6 21h12M7 3c0 5 5 6 5 9s-5 4-5 9M17 3c0 5-5 6-5 9s5 4 5 9" /></>,
  sound: <><path d="M4 9.500v5h4l5 4v-13l-5 4H4Z" /><path d="M16.500 9a4 4 0 0 1 0 6" /></>,
  receipt: <><path d="M7 4h10v17l-2.500-1.500L12 21l-2.500-1.500L7 21V4Z" /><path d="M10 9h4M10 13h4" /></>,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
