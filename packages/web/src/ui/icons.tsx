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
