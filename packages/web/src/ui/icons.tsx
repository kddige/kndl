import type { SVGProps } from "react"

/**
 * A few 16px stroke icons the components need. Decorative by default (aria-hidden): give the
 * control that holds one an accessible name instead.
 */
export type IconProps = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3.5 8.5 3 3 6-7" />
    </Icon>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
    </Icon>
  )
}

export function ChevronUpDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 6 3-3 3 3M5 10l3 3 3-3" />
    </Icon>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 4.5 7 7m0-7-7 7" />
    </Icon>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 3.5v9M3.5 8h9" />
    </Icon>
  )
}

export function StopIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
    </Icon>
  )
}

export function MoreIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="3.5" cy="8" r="0.75" fill="currentColor" />
      <circle cx="8" cy="8" r="0.75" fill="currentColor" />
      <circle cx="12.5" cy="8" r="0.75" fill="currentColor" />
    </Icon>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 8.5h6l.5-8.5" />
    </Icon>
  )
}

export function InfoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 7.25V11M8 5v.01" />
    </Icon>
  )
}

export function InboxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.5 9.5 4 3.5h8l1.5 6v3h-11zM2.5 9.5h3l.75 1.5h3.5l.75-1.5h3" />
    </Icon>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6.5 4.5 3.5 3.5-3.5 3.5" />
    </Icon>
  )
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12.5 8h-9m4-4-4 4 4 4" />
    </Icon>
  )
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 12.5v-9m-4 4 4-4 4 4" />
    </Icon>
  )
}

export function WarningIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 2.75 1.75 13.25h12.5zM8 6.5v3M8 11.5v.01" />
    </Icon>
  )
}

export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="4.5" cy="3.5" r="1.25" />
      <circle cx="4.5" cy="12.5" r="1.25" />
      <circle cx="11.5" cy="5" r="1.25" />
      <path d="M4.5 4.75v6.5M11.5 6.25c0 3-7 2-7 5" />
    </Icon>
  )
}

/** A subagent (ADR 0014). */
export function AgentIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="10" height="8" rx="2" />
      <path d="M8 5V2.5M6.25 9v.5M9.75 9v.5" />
    </Icon>
  )
}

export function KeyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5.5" cy="10.5" r="3" />
      <path d="m7.6 8.4 5.9-5.9M11.5 4.5l1.5 1.5M10 6l1.5 1.5" />
    </Icon>
  )
}

/** A Runner: a machine that runs Sessions. */
export function ServerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.25" y="2.25" width="11.5" height="4.5" rx="1.25" />
      <rect x="2.25" y="9.25" width="11.5" height="4.5" rx="1.25" />
      <path d="M4.75 4.5h.01M4.75 11.5h.01M7.5 4.5h3.75M7.5 11.5h3.75" />
    </Icon>
  )
}

export function CopyIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="5.25" y="5.25" width="8.5" height="8.5" rx="1.5" />
      <path d="M10.75 5.25V3.75a1.5 1.5 0 0 0-1.5-1.5h-5.5a1.5 1.5 0 0 0-1.5 1.5v5.5a1.5 1.5 0 0 0 1.5 1.5h1.5" />
    </Icon>
  )
}

export function BoxIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M8 1.75 13.75 5v6L8 14.25 2.25 11V5L8 1.75Z" />
      <path d="M2.25 5 8 8.25 13.75 5M8 8.25v6" />
    </Icon>
  )
}

export function RestartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.77" />
      <path d="M2.75 2.5v2.75H5.5" />
    </Icon>
  )
}

export function ExternalLinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9.5 2.75h3.75V6.5M13.25 2.75 7.5 8.5" />
      <path d="M11.25 9.5v3a.75.75 0 0 1-.75.75h-7a.75.75 0 0 1-.75-.75v-7a.75.75 0 0 1 .75-.75h3" />
    </Icon>
  )
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5" />
    </Icon>
  )
}

export function ArchiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2" y="3" width="12" height="3" rx="0.75" />
      <path d="M3 6v6.25c0 .41.34.75.75.75h8.5c.41 0 .75-.34.75-.75V6M6.5 8.75h3" />
    </Icon>
  )
}

export function PencilIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9.75 4 2.25 2.25M3 13l.6-2.85 6.9-6.9a1.06 1.06 0 0 1 1.5 0l.75.75a1.06 1.06 0 0 1 0 1.5l-6.9 6.9Z" />
    </Icon>
  )
}

/** Awake: a Session kept awake, which doesn't go to sleep when it's idle (ADR 0016). */
export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5M3.58 3.58l1.06 1.06M11.36 11.36l1.06 1.06M3.58 12.42l1.06-1.06M11.36 4.64l1.06-1.06" />
    </Icon>
  )
}
