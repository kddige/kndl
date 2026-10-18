// A Runner's Monitor on the Runners page (#356): what its host looked like when it last sampled
// it, as stat tiles, and its free disk, available memory and load over the last 7 days, as charts.
// It opens under the Runner's row, and asks the Hub for the history only while it is open. A
// Runner that is offline shows its last sample greyed: the numbers are as of when it went.

import {
  diskIsLow,
  lowDiskBelowBytes,
  type RunnerHistoryPoint,
  RunnerHistoryPointMillis,
  type RunnerSummary,
  type SysinfoSample,
} from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { areaY, defineChart, lineY, ruleY } from "@tanstack/charts"
import { crosshair } from "@tanstack/charts/crosshair"
import { Chart } from "@tanstack/charts/react"
import { scaleLinear } from "@tanstack/charts/scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { bytes, counted, uptime } from "../app/format.ts"
import { useHub } from "../app/hub.tsx"
import { Spinner, WarningIcon } from "../ui/index.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"
import {
  byteUnit,
  type HistoryMeasure,
  historySeries,
  type SeriesPoint,
  sysinfoAge,
  timeTicks,
} from "./runners.ts"

/** How tall each chart is drawn, axes included, in pixels. */
const chartHeight = 132

const styles = stylex.create({
  monitor: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    paddingBlock: space.s4,
    paddingInline: space.s4,
    borderTopWidth: "1px",
    borderTopStyle: "solid",
    borderTopColor: color.border,
    backgroundColor: color.bg,
    // The tiles and charts lay out by the room the Monitor has, not the window's.
    containerType: "inline-size",
  },
  head: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s3,
    flexWrap: "wrap",
  },
  title: {
    margin: 0,
    color: color.text,
    fontSize: text.sm,
    fontWeight: weight.semibold,
  },
  age: { margin: 0, color: color.textMuted, fontSize: text.sm },
  offline: { opacity: 0.55 },
  tiles: {
    display: "grid",
    gridTemplateColumns: {
      default: "repeat(2, minmax(0, 1fr))",
      "@container (min-width: 36rem)": "repeat(4, minmax(0, 1fr))",
    },
    gap: space.s2,
    margin: 0,
  },
  tile: {
    display: "flex",
    flexDirection: "column",
    gap: space.s0_5,
    minWidth: 0,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  tileLabel: { color: color.textMuted, fontSize: text.xs, fontWeight: weight.medium },
  tileValue: {
    margin: 0,
    color: color.text,
    fontSize: text.lg,
    fontWeight: weight.semibold,
    lineHeight: leading.tight,
  },
  tileNotes: { display: "flex", flexDirection: "column", gap: space.s0_5, margin: 0 },
  tileNote: {
    display: "flex",
    alignItems: "center",
    gap: space.s1,
    margin: 0,
    color: color.textMuted,
    fontSize: text.xs,
    lineHeight: leading.snug,
  },
  low: { color: color.warningSubtleText },
  charts: {
    display: "grid",
    gridTemplateColumns: {
      default: "minmax(0, 1fr)",
      "@container (min-width: 44rem)": "repeat(3, minmax(0, 1fr))",
    },
    gap: space.s2,
  },
  chart: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    minWidth: 0,
    margin: 0,
    paddingBlock: space.s2_5,
    paddingInline: space.s3,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surface,
    // The chart's own paint: the series in its token, a threshold in the warning colour, axes and
    // grid in muted text (its default is currentColor), and its tooltip as the app's surfaces.
    color: color.textSubtle,
    "--ts-chart-1": color.chartSeries,
    "--kndl-chart-threshold": color.warning,
    "--ts-chart-tooltip-background": color.surface,
    "--ts-chart-tooltip-color": color.text,
    "--ts-chart-tooltip-border": `1px solid ${color.border}`,
    "--ts-chart-tooltip-border-radius": radius.md,
    "--ts-chart-tooltip-font": `500 ${text.sm}/1.35 ${font.sans}`,
    "--ts-chart-focus-fill": color.surface,
    "--ts-chart-crosshair-marker-fill": color.surface,
  },
  chartHead: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: space.s2,
  },
  chartTitle: { color: color.text, fontSize: text.sm, fontWeight: weight.medium },
  chartSpan: { color: color.textMuted, fontSize: text.xs },
  chartBody: {
    height: `${chartHeight}px`,
    fontSize: text.xs,
    fontFamily: font.sans,
    fontVariantNumeric: "tabular-nums",
  },
  chartEmpty: {
    display: "grid",
    placeItems: "center",
    height: `${chartHeight}px`,
    color: color.textMuted,
    fontSize: text.xs,
    textAlign: "center",
  },
  legend: {
    display: "flex",
    alignItems: "center",
    gap: space.s1_5,
    margin: 0,
    color: color.textMuted,
    fontSize: text.xs,
  },
  thresholdKey: {
    width: "1rem",
    height: 0,
    borderTopWidth: "2px",
    borderTopStyle: "dashed",
    borderTopColor: color.warning,
  },
  note: { margin: 0, color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
})

/** A paint the chart resolves against the card it's in, so it follows the light or dark theme. */
const seriesPaint = "var(--ts-chart-1)"
const thresholdPaint = "var(--kndl-chart-threshold)"

/**
 * A Runner's Monitor: its last sample as tiles, and its history as charts. `id` names it for the
 * toggle that opens it.
 */
export function RunnerMonitor({
  id,
  runner,
  now,
}: {
  id: string
  runner: RunnerSummary
  now: number
}) {
  const history = useRunnerHistory(runner, now)
  const sysinfo = runner.sysinfo
  return (
    <section id={id} aria-label={`${runner.name}'s monitor`} {...stylex.props(styles.monitor)}>
      <div {...stylex.props(styles.head)}>
        <h3 {...stylex.props(styles.title)}>Host</h3>
        {sysinfo && (
          <p {...stylex.props(styles.age)}>
            {runner.isOnline ? "As of" : "Offline, as of"} {sysinfoAge(sysinfo.at, now)}
          </p>
        )}
      </div>
      {sysinfo ? (
        <HostTiles sysinfo={sysinfo} offline={!runner.isOnline} />
      ) : (
        <p {...stylex.props(styles.note)}>
          {runner.isOnline
            ? "It hasn't sent a sample of its host: it may be too old to. Update it to see one."
            : "Nothing sampled since the Hub last started. Its history is below."}
        </p>
      )}
      <HistoryCharts runner={runner} history={history} />
    </section>
  )
}

/** What share `part` is of `whole`, after it: " (37%)"; nothing of a whole that is zero. */
const share = (part: number, whole: number) =>
  whole > 0 ? ` (${Math.round((part / whole) * 100)}%)` : ""

/** The latest sample as tiles: disk, memory, load and uptime. */
function HostTiles({ sysinfo, offline }: { sysinfo: SysinfoSample; offline: boolean }) {
  const low = diskIsLow(sysinfo)
  const [load1, load5, load15] = sysinfo.loadAverage
  return (
    <dl
      data-offline={offline ? "" : undefined}
      {...stylex.props(styles.tiles, offline && styles.offline)}
    >
      <Tile label="Free disk" value={bytes(sysinfo.diskFreeBytes)}>
        <span {...stylex.props(styles.tileNote)}>
          of {bytes(sysinfo.diskTotalBytes)}
          {share(sysinfo.diskFreeBytes, sysinfo.diskTotalBytes)}
        </span>
        {low && (
          <span {...stylex.props(styles.tileNote, styles.low)}>
            <WarningIcon /> Low: under {bytes(lowDiskBelowBytes(sysinfo.diskTotalBytes))}
          </span>
        )}
      </Tile>
      <Tile label="Available memory" value={bytes(sysinfo.memoryAvailableBytes)}>
        <span {...stylex.props(styles.tileNote)}>
          of {bytes(sysinfo.memoryTotalBytes)}
          {share(sysinfo.memoryAvailableBytes, sysinfo.memoryTotalBytes)}
        </span>
      </Tile>
      <Tile label="Load, 1 minute" value={load1.toFixed(2)}>
        <span {...stylex.props(styles.tileNote)}>
          on {counted(sysinfo.cpuCores, { one: "core", other: "cores" })}
        </span>
        <span {...stylex.props(styles.tileNote)}>
          5 min {load5.toFixed(2)} · 15 min {load15.toFixed(2)}
        </span>
      </Tile>
      <Tile label="Up" value={uptime(sysinfo.uptimeSeconds)}>
        <span {...stylex.props(styles.tileNote)}>
          {sysinfo.os} {sysinfo.arch}
        </span>
      </Tile>
    </dl>
  )
}

function Tile({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div {...stylex.props(styles.tile)}>
      <dt {...stylex.props(styles.tileLabel)}>{label}</dt>
      <dd {...stylex.props(styles.tileValue)}>{value}</dd>
      <dd {...stylex.props(styles.tileNotes)}>{children}</dd>
    </div>
  )
}

/** The history as the Hub sent it, or where the asking is at. */
type History =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed" }
  | { readonly _tag: "Loaded"; readonly points: ReadonlyArray<RunnerHistoryPoint> }

/**
 * A Runner's history, asked of the Hub as the Monitor opens and again each time the Hub keeps
 * another point (every 5 minutes) while the Runner is online. What was shown stays until the
 * answer comes, so the charts don't flash.
 */
function useRunnerHistory(runner: RunnerSummary, now: number): History {
  const hub = useHub()
  const [history, setHistory] = useState<History>({ _tag: "Loading" })
  const bucket = runner.isOnline ? Math.floor(now / RunnerHistoryPointMillis) : 0
  useEffect(() => {
    let current = true
    hub
      .runnerHistory(runner.id)
      .then((points) => {
        if (current) setHistory({ _tag: "Loaded", points })
      })
      .catch(() => {
        if (current) setHistory((shown) => (shown._tag === "Loaded" ? shown : { _tag: "Failed" }))
      })
    return () => {
      current = false
    }
  }, [hub, runner.id, bucket])
  return history
}

/** What each chart draws, and how its values read. */
interface ChartSpec {
  readonly measure: HistoryMeasure
  readonly title: string
  /** How a value reads, in the tooltip and the chart's name. */
  readonly format: (value: number) => string
  readonly bytes: boolean
  /** A fixed top for the value axis: memory's total. */
  readonly max?: number
  /** A line across the chart, with what it means: the low-disk threshold. */
  readonly threshold?: { readonly value: number; readonly label: string }
}

function HistoryCharts({ runner, history }: { runner: RunnerSummary; history: History }) {
  const diskTotal = runner.sysinfo?.diskTotalBytes
  const memoryTotal = runner.sysinfo?.memoryTotalBytes
  // Made again only when a total changes, as each new spec redraws its chart.
  const specs = useMemo(
    (): ReadonlyArray<ChartSpec> => [
      {
        measure: "diskFreeBytes",
        title: "Free disk",
        format: bytes,
        bytes: true,
        ...(diskTotal !== undefined &&
          diskTotal > 0 && {
            threshold: {
              value: lowDiskBelowBytes(diskTotal),
              label: `Low disk, under ${bytes(lowDiskBelowBytes(diskTotal))}`,
            },
          }),
      },
      {
        measure: "memoryAvailableBytes",
        title: "Available memory",
        format: bytes,
        bytes: true,
        ...(memoryTotal !== undefined && memoryTotal > 0 && { max: memoryTotal }),
      },
      {
        measure: "load1",
        title: "Load, 1 minute",
        format: (load) => load.toFixed(2),
        bytes: false,
      },
    ],
    [diskTotal, memoryTotal],
  )
  return (
    <div {...stylex.props(styles.charts)}>
      {specs.map((spec) => (
        <HistoryChartCard key={spec.measure} spec={spec} history={history} />
      ))}
    </div>
  )
}

function HistoryChartCard({ spec, history }: { spec: ChartSpec; history: History }) {
  const series = useMemo(
    () => (history._tag === "Loaded" ? historySeries(history.points, spec.measure) : []),
    [history, spec.measure],
  )
  return (
    <figure {...stylex.props(styles.chart)}>
      <figcaption {...stylex.props(styles.chartHead)}>
        <span {...stylex.props(styles.chartTitle)}>{spec.title}</span>
        <span {...stylex.props(styles.chartSpan)}>Last 7 days</span>
      </figcaption>
      {history._tag === "Loading" ? (
        <div {...stylex.props(styles.chartEmpty)}>
          <Spinner size="sm" label={`Loading ${spec.title.toLowerCase()}`} />
        </div>
      ) : history._tag === "Failed" ? (
        <p {...stylex.props(styles.chartEmpty)}>Couldn't load the history.</p>
      ) : series.length < 2 ? (
        <p {...stylex.props(styles.chartEmpty)}>
          Not enough history yet: the Hub keeps a point every 5 minutes.
        </p>
      ) : (
        <HistoryChart spec={spec} series={series} />
      )}
      {spec.threshold && (
        <p {...stylex.props(styles.legend)}>
          <span aria-hidden="true" {...stylex.props(styles.thresholdKey)} />
          {spec.threshold.label}
        </p>
      )}
    </figure>
  )
}

/** A short day, or a time of day, for a time axis tick. */
const tickFormats = {
  day: (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "short" }),
  hour: (at: number) =>
    new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
}

/** When a point was, in its tooltip: "Mon 14:05". */
const pointTime = (at: number) =>
  new Date(at).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })

/** A whole number as it reads on an axis, a decimal under ten: "0", "2.5", "150". */
const axisNumber = (value: number) =>
  Math.abs(value) < 10 && !Number.isInteger(value)
    ? value.toFixed(1)
    : Math.round(value).toLocaleString()

/**
 * One measure over time: a 10% wash of the series colour under a 2px line, the value axis from zero,
 * a hairline grid, and a crosshair and tooltip that snap to the nearest point.
 */
function HistoryChart({ spec, series }: { spec: ChartSpec; series: ReadonlyArray<SeriesPoint> }) {
  const definition = useMemo(() => {
    const first = series[0]?.at ?? 0
    const last = series.at(-1)?.at ?? first
    const ticks = timeTicks(first, last)
    const top = Math.max(spec.max ?? 0, spec.threshold?.value ?? 0, ...series.map((p) => p.value))
    // Bytes are charted in the unit that fits, so the axis ticks are round numbers of it.
    const unit = spec.bytes ? byteUnit(top) : undefined
    const per = unit?.bytes ?? 1
    const scaled = series.map((point) => ({
      at: point.at,
      value: point.value / per,
      raw: point.value,
    }))
    return defineChart({
      marks: [
        areaY(scaled, { x: "at", y: "value", fill: seriesPaint, fillOpacity: 0.1 }),
        lineY(scaled, { x: "at", y: "value", stroke: seriesPaint, strokeWidth: 2 }),
        ...(spec.threshold
          ? [
              ruleY([spec.threshold.value / per], {
                stroke: thresholdPaint,
                strokeOpacity: 1,
                strokeWidth: 1.5,
                strokeDasharray: "4 3",
              }),
            ]
          : []),
        crosshair({ y: false, strokeOpacity: 0.5, marker: { radius: 4, fill: seriesPaint } }),
      ],
      scales: {
        x: {
          scale: () => scaleLinear().domain([first, last]),
          axis: {
            line: { strokeOpacity: 0.25 },
            ticks: { values: ticks.values, size: 0, format: tickFormats[ticks.unit] },
          },
        },
        y: {
          // Memory is charted against its total, so the chart says how close it came to running out.
          scale: spec.max === undefined ? scaleLinear : scaleLinear().domain([0, spec.max / per]),
          nice: spec.max === undefined ? 4 : false,
          grid: { strokeOpacity: 0.15 },
          axis: {
            line: false,
            ticks: {
              count: 4,
              size: 0,
              format: (value) => (unit ? `${axisNumber(value)} ${unit.name}` : axisNumber(value)),
            },
          },
        },
      },
      focus: "nearest-x",
      maxFocusDistance: Number.POSITIVE_INFINITY,
      tooltip: {
        use: tooltip,
        content: (points) => {
          const point = points[0]
          return point === undefined
            ? { rows: [] }
            : {
                title: pointTime(point.datum.at),
                rows: [
                  { label: spec.title, value: spec.format(point.datum.raw), color: seriesPaint },
                ],
              }
        },
      },
    })
  }, [spec, series])
  const values = series.map((point) => point.value)
  return (
    <div {...stylex.props(styles.chartBody)}>
      <Chart
        definition={definition}
        height={chartHeight}
        initialWidth={280}
        ariaLabel={`${spec.title} over the last 7 days: from ${spec.format(values[0] ?? 0)} to ${spec.format(values.at(-1) ?? 0)}, lowest ${spec.format(Math.min(...values))}, highest ${spec.format(Math.max(...values))}`}
      />
    </div>
  )
}
