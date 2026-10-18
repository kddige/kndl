// The signed-in person's Connected providers (ADR 0029), on the Account page beside their Claude
// credential. Those connected come first, each with the account, its Models and when they were
// checked. Then every other Provider the Hub can connect, a line each: those with a subscription
// sign-in first, then those that take an API key, the most used first and the rest behind "Show
// more". A line opens in place for its sign-in's steps, or for the key's field. The Hub runs each
// sign-in itself and sends its steps: a page to open, which for ChatGPT's and OpenRouter's lands on
// an address on the Hub's own machine that won't load here, so its address is pasted back; a code
// to enter on the Provider's page; a choice; or what it is doing. Keys and pasted addresses go to
// the Hub write-only, and are never shown again.

import type { ConnectableProvider, ConnectedProvider, ProviderId, SignInStep } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { type FormEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react"
import { day, timeAgo } from "../app/format.ts"
import { useHub, useHubState } from "../app/hub.tsx"
import type { SignInProgress } from "../hub/store.ts"
import { thinkingLevelNames } from "../session/models.ts"
import {
  Banner,
  Button,
  CopyIcon,
  Dialog,
  DialogClose,
  Disclosure,
  ExternalLinkIcon,
  Field,
  IconButton,
  Input,
  KeyIcon,
  PlugIcon,
  Spinner,
  toast,
  WarningIcon,
} from "../ui/index.ts"
import { color, font, leading, radius, space, text, weight } from "../ui/tokens.stylex.ts"

const styles = stylex.create({
  group: { display: "flex", flexDirection: "column", gap: space.s3 },
  groupHead: { display: "flex", flexDirection: "column", gap: space.s0_5 },
  groupTitle: { margin: 0, fontSize: text.lg, fontWeight: weight.semibold },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    padding: space.s4,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.lg,
    backgroundColor: color.surface,
  },
  sectionHead: { display: "flex", flexDirection: "column", gap: space.s0_5 },
  sectionTitle: { margin: 0, fontSize: text.md, fontWeight: weight.semibold },
  note: { margin: 0, color: color.textMuted, fontSize: text.sm, lineHeight: leading.snug },
  form: { display: "flex", flexDirection: "column", gap: space.s3 },
  mono: { fontFamily: font.mono },
  facts: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
    gap: space.s4,
    margin: 0,
  },
  fact: { display: "flex", flexDirection: "column", gap: space.s0_5, minWidth: 0 },
  term: { color: color.textMuted, fontSize: text.sm },
  detail: {
    margin: 0,
    fontSize: text.base,
    fontWeight: weight.medium,
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  actions: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: space.s2 },
  error: { margin: 0, color: color.dangerSubtleText, fontSize: text.sm, lineHeight: leading.snug },
  loading: { display: "grid", placeItems: "center", paddingBlock: space.s8 },
  models: {
    display: "flex",
    flexDirection: "column",
    gap: space.s1,
    margin: 0,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    listStyle: "none",
  },
  model: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: space.s2,
    fontSize: text.sm,
    lineHeight: leading.snug,
  },
  modelId: { color: color.textMuted, fontFamily: font.mono, fontSize: text.xs },
  signIn: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    padding: space.s3,
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  codeRow: { display: "flex", alignItems: "center", gap: space.s2 },
  code: {
    fontFamily: font.mono,
    fontSize: text.lg,
    fontWeight: weight.semibold,
    letterSpacing: "0.08em",
    userSelect: "all",
  },
  progress: {
    display: "flex",
    alignItems: "center",
    gap: space.s2,
    color: color.textMuted,
    fontSize: text.sm,
  },
  // The Providers not connected: a titled list of lines each.
  kind: { display: "flex", flexDirection: "column", gap: space.s1 },
  kindTitle: {
    margin: 0,
    color: color.textMuted,
    fontSize: text.xs,
    fontWeight: weight.semibold,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  lines: {
    display: "flex",
    flexDirection: "column",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.md,
  },
  line: {
    display: "flex",
    flexDirection: "column",
    gap: space.s3,
    paddingBlock: space.s2,
    paddingInline: space.s3,
    borderTopWidth: { default: "1px", ":first-child": 0 },
    borderTopStyle: "solid",
    borderTopColor: color.border,
  },
  lineHead: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: space.s3,
    rowGap: space.s2,
    minHeight: "2rem",
  },
  lineName: { flexGrow: 1, fontSize: text.base, fontWeight: weight.medium },
  // Wrapped under a long name, on a phone, the buttons stay at the end of the line.
  lineActions: { justifyContent: "flex-end", marginInlineStart: "auto" },
  more: { alignSelf: "flex-start" },
  // A sign-in's numbered steps: the page to sign in on, then the address it lands on.
  stepList: {
    display: "flex",
    flexDirection: "column",
    gap: space.s4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  step: { display: "flex", alignItems: "flex-start", gap: space.s2_5 },
  stepNumber: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    width: "1.25rem",
    height: "1.25rem",
    borderWidth: "1px",
    borderStyle: "solid",
    borderColor: color.border,
    borderRadius: radius.full,
    backgroundColor: color.surface,
    color: color.textMuted,
    fontSize: text.xs,
    fontWeight: weight.semibold,
  },
  stepBody: { display: "flex", flexDirection: "column", gap: space.s2, flex: 1, minWidth: 0 },
  footer: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.s2,
  },
})

/** How many of the Providers that take only a key are listed before "Show more". */
const keyLinesShown = 6

/**
 * The Providers heading, with the Claude credential's section (`claude`), the Connected provider
 * for Anthropic, then a section for each Connected provider, and a list of the rest to connect.
 */
export function ProvidersSection({ claude }: { claude: ReactNode }) {
  const hub = useHub()
  const providers = useHubState((state) => state.providers)
  const claudeCredential = useHubState((state) => state.claudeCredential)
  const [error, setError] = useState<string | null>(null)
  // Nothing to run a Session on yet: say so first, and where to start.
  const nothing = providers?.connected.length === 0 && claudeCredential === null

  // The Hub sends them after its welcome; ask, in case this page came first.
  const missing = providers === null
  useEffect(() => {
    if (!missing) return
    hub.getProviders().catch((cause: unknown) => setError(messageOf(cause)))
  }, [hub, missing])

  return (
    <section aria-labelledby="providers" {...stylex.props(styles.group)}>
      <div {...stylex.props(styles.groupHead)}>
        <h2 id="providers" {...stylex.props(styles.groupTitle)}>
          Providers
        </h2>
        <p {...stylex.props(styles.note)}>
          The accounts your Sessions run their Models on. Only the Sessions you start use them.
        </p>
      </div>
      {nothing && (
        <Banner intent="accent" icon={<PlugIcon />} title="Connect a Provider to start Sessions">
          A Session runs on its Creator's own accounts. Add your Claude setup token, or sign in or
          paste an API key for any Provider below.
        </Banner>
      )}
      {claude}
      {providers === null ? (
        error === null ? (
          <div {...stylex.props(styles.loading)}>
            <Spinner label="Loading your Providers" />
          </div>
        ) : (
          <p role="alert" {...stylex.props(styles.error)}>
            Couldn't load your Providers: {error}
          </p>
        )
      ) : (
        <ProviderList connected={providers.connected} connectable={providers.connectable} />
      )}
    </section>
  )
}

/** Each Connected provider, then every other Provider the Hub can connect. */
function ProviderList({
  connected,
  connectable,
}: {
  connected: ReadonlyArray<ConnectedProvider>
  connectable: ReadonlyArray<ConnectableProvider>
}) {
  const connectionOf = (provider: ProviderId) =>
    connected.find((each) => each.provider === provider)
  const others = connectable.filter((each) => connectionOf(each.provider) === undefined)
  return (
    <>
      {connectable.flatMap((each) => {
        const connection = connectionOf(each.provider)
        return connection === undefined
          ? []
          : [<ProviderCard key={each.provider} connectable={each} connected={connection} />]
      })}
      {others.length > 0 && <MoreProviders others={others} anyConnected={connected.length > 0} />}
    </>
  )
}

/**
 * The Providers not connected, a line each: those with a subscription sign-in, then those that
 * take only an API key, the first few of them until "Show more".
 */
function MoreProviders({
  others,
  anyConnected,
}: {
  others: ReadonlyArray<ConnectableProvider>
  anyConnected: boolean
}) {
  const [all, setAll] = useState(false)
  const subscriptions = others.filter((each) => each.signIn !== undefined)
  const keys = others.filter((each) => each.signIn === undefined && each.apiKey)
  const shownKeys = all ? keys : keys.slice(0, keyLinesShown)
  return (
    <section aria-labelledby="connect-provider" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h3 id="connect-provider" {...stylex.props(styles.sectionTitle)}>
          {anyConnected ? "Connect another Provider" : "Connect a Provider"}
        </h3>
        <p {...stylex.props(styles.note)}>
          Sign in with a subscription you have, or paste an API key. The Hub keeps it encrypted, and
          only your Sessions use it.
        </p>
      </div>
      {subscriptions.length > 0 && (
        <ProviderLines title="Subscriptions" id="connect-subscriptions">
          {subscriptions.map((each) => (
            <ProviderLine key={each.provider} connectable={each} />
          ))}
        </ProviderLines>
      )}
      {keys.length > 0 && (
        <ProviderLines title="API keys" id="connect-keys">
          {shownKeys.map((each) => (
            <ProviderLine key={each.provider} connectable={each} />
          ))}
        </ProviderLines>
      )}
      {shownKeys.length < keys.length && (
        <Button size="sm" intent="ghost" sx={styles.more} onClick={() => setAll(true)}>
          Show {keys.length - shownKeys.length} more
        </Button>
      )}
    </section>
  )
}

function ProviderLines({
  title,
  id,
  children,
}: {
  title: string
  id: string
  children: ReactNode
}) {
  return (
    <div role="group" aria-labelledby={id} {...stylex.props(styles.kind)}>
      <h4 id={id} {...stylex.props(styles.kindTitle)}>
        {title}
      </h4>
      <div {...stylex.props(styles.lines)}>{children}</div>
    </div>
  )
}

/** The Member's sign-in to the Provider, if one is running or just ended, and how to start one. */
function useSignIn(connectable: ConnectableProvider, onConnected: () => void) {
  const hub = useHub()
  const { provider, name } = connectable
  const signIn = useHubState((state) => (state.signIn?.provider === provider ? state.signIn : null))
  const [startError, setStartError] = useState<string | null>(null)

  const start = () => {
    setStartError(null)
    // The last one's outcome goes: the store then follows this one.
    hub.clearSignIn()
    hub.startSignIn(provider).then(
      (ended) => {
        if (ended.outcome !== "Connected") return
        onConnected()
        hub.clearSignIn(ended.requestId)
        toast.show({ title: `Connected ${name}` })
      },
      // The store holds why a sign-in it follows failed; this is one that was never sent.
      (cause: unknown) => {
        if (hub.getState().signIn === null) setStartError(messageOf(cause))
      },
    )
  }

  return {
    signIn,
    running: signIn !== null && signIn.ended === null,
    failed: signIn?.ended?.outcome === "Failed" ? signIn.ended : null,
    start,
    startError,
  }
}

/** A Provider not connected: its name, its sign-in or key, and either, open, in place. */
function ProviderLine({ connectable }: { connectable: ConnectableProvider }) {
  const { provider, name } = connectable
  const [keyOpen, setKeyOpen] = useState(false)
  const flow = useSignIn(connectable, () => setKeyOpen(false))
  const titleId = `provider-${provider}`
  const ref = useRef<HTMLElement>(null)
  useFocusKept(ref)

  return (
    <section ref={ref} aria-labelledby={titleId} {...stylex.props(styles.line)}>
      <div {...stylex.props(styles.lineHead)}>
        <span id={titleId} {...stylex.props(styles.lineName)}>
          {name}
        </span>
        {!flow.running && (
          <div {...stylex.props(styles.actions, styles.lineActions)}>
            {connectable.signIn !== undefined && (
              <Button size="sm" onClick={flow.start}>
                {connectable.signIn}
              </Button>
            )}
            {connectable.apiKey && !keyOpen && (
              <Button
                size="sm"
                intent={connectable.signIn === undefined ? "secondary" : "ghost"}
                icon={<KeyIcon />}
                onClick={() => setKeyOpen(true)}
              >
                {connectable.signIn === undefined ? "Add API key" : "API key"}
              </Button>
            )}
          </div>
        )}
      </div>
      {flow.running && flow.signIn !== null && <SignInSteps name={name} signIn={flow.signIn} />}
      {!flow.running && flow.failed !== null && (
        <Banner intent="danger" icon={<WarningIcon />} title="The sign-in failed">
          {flow.failed.message}
        </Banner>
      )}
      {flow.startError !== null && (
        <p role="alert" {...stylex.props(styles.error)}>
          {flow.startError}
        </p>
      )}
      {keyOpen && !flow.running && (
        <KeyForm
          connectable={connectable}
          autoFocus
          onDone={() => setKeyOpen(false)}
          onCancel={() => setKeyOpen(false)}
        />
      )}
    </section>
  )
}

/** A Connected provider: what is connected, and its sign-in while one replaces it. */
function ProviderCard({
  connectable,
  connected,
}: {
  connectable: ConnectableProvider
  connected: ConnectedProvider
}) {
  const { provider, name } = connectable
  const [replacing, setReplacing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const flow = useSignIn(connectable, () => setReplacing(false))
  const titleId = `provider-${provider}`
  const ref = useRef<HTMLElement>(null)
  useFocusKept(ref)

  return (
    <section ref={ref} aria-labelledby={titleId} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h3 id={titleId} {...stylex.props(styles.sectionTitle)}>
          {name}
        </h3>
        <p {...stylex.props(styles.note)}>{noteFor(connectable)}</p>
      </div>
      {flow.running && flow.signIn !== null ? (
        <SignInSteps name={name} signIn={flow.signIn} />
      ) : !replacing ? (
        <Connection
          name={name}
          connected={connected}
          onReplace={() => setReplacing(true)}
          onDisconnect={() => setDisconnecting(true)}
        />
      ) : (
        <>
          {flow.failed !== null && (
            <Banner intent="danger" icon={<WarningIcon />} title="The sign-in failed">
              {flow.failed.message}
            </Banner>
          )}
          <Connect
            connectable={connectable}
            onSignIn={flow.start}
            signInError={flow.startError}
            onDone={() => setReplacing(false)}
          />
        </>
      )}
      <DisconnectDialog
        provider={provider}
        name={name}
        open={disconnecting}
        onClose={() => setDisconnecting(false)}
      />
    </section>
  )
}

const noteFor = (connectable: ConnectableProvider) =>
  connectable.signIn !== undefined && connectable.apiKey
    ? "Sign in with your subscription, or paste an API key."
    : connectable.signIn !== undefined
      ? "Sign in with your subscription."
      : "Paste an API key."

/** What is connected: the account or key, its Models, and what can be done with it. */
function Connection({
  name,
  connected,
  onReplace,
  onDisconnect,
}: {
  name: string
  connected: ConnectedProvider
  onReplace: () => void
  onDisconnect: () => void
}) {
  const hub = useHub()
  const [refreshing, setRefreshing] = useState(false)
  const count = connected.models.length
  const checked =
    connected.modelsCheckedAt === undefined
      ? "not checked yet"
      : `checked ${timeAgo(connected.modelsCheckedAt)}`

  const refresh = async () => {
    setRefreshing(true)
    try {
      await hub.refreshProviderModels(connected.provider)
    } catch (cause) {
      toast.show({
        title: `Couldn't refresh ${name}'s Models`,
        description: messageOf(cause),
        intent: "danger",
      })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <>
      {connected.problem !== undefined && (
        <Banner intent="danger" icon={<WarningIcon />} title="It doesn't work anymore">
          {connected.problem} Connect it again.
        </Banner>
      )}
      {connected.modelsProblem !== undefined && (
        <Banner intent="warning" icon={<WarningIcon />} title="Couldn't check its Models">
          {connected.modelsProblem}
        </Banner>
      )}
      <dl aria-label={`Your ${name} connection`} {...stylex.props(styles.facts)}>
        {connected.kind === "SignIn" ? (
          <Fact term="Account">
            <span title={connected.label}>{connected.label}</span>
          </Fact>
        ) : (
          <Fact term="Ends in">
            <span {...stylex.props(styles.mono)}>…{connected.label}</span>
          </Fact>
        )}
        <Fact term="Kind">{connected.kind === "SignIn" ? "Subscription" : "API key"}</Fact>
        <Fact term="Connected">{day(connected.connectedAt)}</Fact>
      </dl>
      <Disclosure summary={`${count === 1 ? "1 Model" : `${count} Models`} · ${checked}`}>
        {count === 0 ? (
          <p {...stylex.props(styles.note, styles.models)}>{name} listed none that kndl can run.</p>
        ) : (
          <ul aria-label={`${name}'s Models`} {...stylex.props(styles.models)}>
            {connected.models.map((model) => (
              <li key={model.id} {...stylex.props(styles.model)}>
                <span>{model.label}</span>
                <span {...stylex.props(styles.modelId)}>{model.id}</span>
                <span {...stylex.props(styles.note)}>{levelsText(model.thinkingLevels)}</span>
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
      <div {...stylex.props(styles.actions)}>
        <Button size="sm" loading={refreshing} onClick={() => void refresh()}>
          Refresh models
        </Button>
        <Button size="sm" onClick={onReplace}>
          Replace
        </Button>
        <Button size="sm" intent="ghost" onClick={onDisconnect}>
          Disconnect
        </Button>
      </div>
    </>
  )
}

/** A Model's thinking levels, lowest to highest: `Thinking Low to High`. */
function levelsText(levels: ReadonlyArray<keyof typeof thinkingLevelNames>): string {
  const [lowest] = levels
  const highest = levels.at(-1)
  if (lowest === undefined || highest === undefined) return "No thinking"
  return lowest === highest
    ? `Thinking ${thinkingLevelNames[lowest]}`
    : `Thinking ${thinkingLevelNames[lowest]} to ${thinkingLevelNames[highest]}`
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div {...stylex.props(styles.fact)}>
      <dt {...stylex.props(styles.term)}>{term}</dt>
      <dd {...stylex.props(styles.detail)}>{children}</dd>
    </div>
  )
}

/** The Provider's sign-in, and a form to paste an API key, to replace a connection: either does. */
function Connect({
  connectable,
  onSignIn,
  signInError,
  onDone,
}: {
  connectable: ConnectableProvider
  onSignIn: () => void
  signInError: string | null
  onDone: () => void
}) {
  return (
    <>
      {connectable.signIn !== undefined && (
        <div {...stylex.props(styles.actions)}>
          <Button intent="primary" onClick={onSignIn}>
            {connectable.signIn}
          </Button>
          {!connectable.apiKey && (
            <Button intent="ghost" onClick={onDone}>
              Cancel
            </Button>
          )}
        </div>
      )}
      {signInError !== null && (
        <p role="alert" {...stylex.props(styles.error)}>
          {signInError}
        </p>
      )}
      {connectable.apiKey && (
        <KeyForm connectable={connectable} onDone={onDone} onCancel={onDone} />
      )}
    </>
  )
}

/** A field to paste the Provider's API key in, which the Hub checks with it as it saves it. */
function KeyForm({
  connectable,
  autoFocus = false,
  onDone,
  onCancel,
}: {
  connectable: ConnectableProvider
  autoFocus?: boolean
  onDone: () => void
  onCancel?: () => void
}) {
  const hub = useHub()
  const { provider, name } = connectable
  const [apiKey, setApiKey] = useState("")
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const empty = apiKey.trim() === ""

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (empty) return
    setBusy(true)
    setError(null)
    try {
      await hub.connectProviderKey(provider, apiKey.trim())
      setApiKey("")
      setTouched(false)
      toast.show({ title: `Connected ${name}` })
      onDone()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
      <Field
        label={connectable.keyName ?? "API key"}
        description={`Checked with ${name} as it is saved. It is stored encrypted and never shown again.`}
        invalid={(touched && empty) || error !== null}
        error={touched && empty ? "Paste a key." : undefined}
      >
        <Input
          type="password"
          value={apiKey}
          autoComplete="off"
          onValueChange={(next: string) => {
            setApiKey(next)
            setError(null)
          }}
          spellCheck={false}
          autoCapitalize="off"
          autoFocus={autoFocus}
          sx={styles.mono}
        />
      </Field>
      {error !== null && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        <Button type="submit" icon={<KeyIcon />} loading={busy}>
          Connect
        </Button>
        {onCancel !== undefined && (
          <Button intent="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  )
}

/**
 * A sign-in in progress, as far as the Hub's steps go. ChatGPT's and OpenRouter's are two numbered
 * steps: the page to sign in on, then the address the browser lands on, pasted back. A device-code
 * sign-in's is the code to enter on the Provider's page. Then what it asks, a paste or a choice, or
 * what it is doing; and Cancel.
 */
function SignInSteps({ name, signIn }: { name: string; signIn: SignInProgress }) {
  const hub = useHub()
  // How many steps had come when the last answer was sent: it is asked again only by a new one.
  const [answeredAt, setAnsweredAt] = useState(-1)
  const pasteField = useRef<HTMLInputElement>(null)
  const { steps } = signIn
  const page = steps.findLast((step) => step._tag === "OpenUrl" || step._tag === "EnterCode")
  const last = steps.at(-1)
  const asking = steps.length > answeredAt && (last?._tag === "Paste" || last?._tag === "Choose")
  const progress = last?._tag === "Progress" ? last.message : undefined

  const answer = (value: string) => {
    if (hub.answerSignIn(value)) setAnsweredAt(steps.length)
  }
  const cancel = (
    <Button size="sm" intent="ghost" onClick={() => hub.cancelSignIn()}>
      Cancel
    </Button>
  )

  const next =
    asking && last?._tag === "Paste" ? (
      <PasteForm
        step={last}
        afterPage={page?._tag === "OpenUrl"}
        inputRef={pasteField}
        onAnswer={answer}
        cancel={cancel}
        key={steps.length}
      />
    ) : asking && last?._tag === "Choose" ? (
      <div {...stylex.props(styles.form)}>
        <p {...stylex.props(styles.note)}>{last.message}</p>
        <div {...stylex.props(styles.actions)}>
          {last.options.map((option) => (
            <Button key={option.id} size="sm" onClick={() => answer(option.id)}>
              {option.label}
            </Button>
          ))}
          {cancel}
        </div>
      </div>
    ) : (
      <div {...stylex.props(styles.footer)}>
        <div role="status" {...stylex.props(styles.progress)}>
          <Spinner size="sm" />
          <span>{progress ?? `Waiting for ${name}…`}</span>
        </div>
        {cancel}
      </div>
    )

  return (
    <div role="group" aria-label={`Signing in to ${name}`} {...stylex.props(styles.signIn)}>
      {page?._tag === "OpenUrl" ? (
        <ol {...stylex.props(styles.stepList)}>
          <SignInStepItem number={1}>
            <p {...stylex.props(styles.note)}>
              {page.instructions !== undefined && page.instructions !== ""
                ? page.instructions
                : `Sign in to ${name} on its page.`}
            </p>
            <PageLink url={page.url} onOpen={() => pasteField.current?.focus()} />
          </SignInStepItem>
          <SignInStepItem number={2}>{next}</SignInStepItem>
        </ol>
      ) : (
        <>
          {page?._tag === "EnterCode" && (
            <>
              <p {...stylex.props(styles.note)}>Enter this code on {name}'s sign-in page:</p>
              <div {...stylex.props(styles.codeRow)}>
                <span aria-label="Sign-in code" {...stylex.props(styles.code)}>
                  {page.code}
                </span>
                <IconButton label="Copy code" size="sm" onClick={() => void copyCode(page.code)}>
                  <CopyIcon />
                </IconButton>
              </div>
              <PageLink url={page.url} />
            </>
          )}
          {next}
        </>
      )}
    </div>
  )
}

function SignInStepItem({ number, children }: { number: number; children: ReactNode }) {
  return (
    <li {...stylex.props(styles.step)}>
      <span aria-hidden="true" {...stylex.props(styles.stepNumber)}>
        {number}
      </span>
      <div {...stylex.props(styles.stepBody)}>{children}</div>
    </li>
  )
}

/**
 * The Provider's sign-in page, in a new tab. It takes the focus as it comes, from the sign-in's
 * Cancel or from nowhere, as when the button that started the sign-in went: it's what to do next.
 */
function PageLink({ url, onOpen }: { url: string; onOpen?: () => void }) {
  const ref = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    const link = ref.current
    const active = document.activeElement
    if (link === null) return
    if (
      active === null ||
      active === document.body ||
      link.closest('[role="group"]')?.contains(active)
    )
      link.focus()
  }, [])
  return (
    <div {...stylex.props(styles.actions)}>
      <Button
        intent="primary"
        size="sm"
        nativeButton={false}
        render={<a ref={ref} href={url} target="_blank" rel="noreferrer noopener" />}
        onClick={onOpen}
      >
        Open the sign-in page
        <ExternalLinkIcon aria-hidden="true" />
      </Button>
    </div>
  )
}

/**
 * A Paste step's box. After a page to open, it is for the address the browser landed on: ChatGPT's
 * and OpenRouter's sign-ins send it to the Hub's own machine, which doesn't load from here. The
 * box takes the focus as the page opens, ready to paste into on coming back.
 */
function PasteForm({
  step,
  afterPage,
  inputRef,
  onAnswer,
  cancel,
}: {
  step: Extract<SignInStep, { _tag: "Paste" }>
  afterPage: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onAnswer: (value: string) => void
  cancel: ReactNode
}) {
  const [value, setValue] = useState("")
  const empty = value.trim() === ""
  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!empty) onAnswer(value.trim())
      }}
      {...stylex.props(styles.form)}
    >
      <Field
        label={afterPage ? "Address of the page you landed on" : step.message}
        description={afterPage && step.message !== "" ? step.message : undefined}
      >
        <Input
          ref={inputRef}
          value={value}
          autoComplete="off"
          onValueChange={(next: string) => setValue(next)}
          {...(step.placeholder !== undefined && { placeholder: step.placeholder })}
          spellCheck={false}
          autoCapitalize="off"
          autoFocus={!afterPage}
          sx={styles.mono}
        />
      </Field>
      <div {...stylex.props(styles.actions)}>
        <Button type="submit" size="sm" disabled={empty}>
          Continue
        </Button>
        {cancel}
      </div>
    </form>
  )
}

async function copyCode(code: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(code)
    toast.show({ title: "Copied the code" })
  } catch {
    toast.show({
      title: "Couldn't copy",
      description: "Select the code and copy it yourself.",
      intent: "warning",
    })
  }
}

function DisconnectDialog({
  provider,
  name,
  open,
  onClose,
}: {
  provider: ProviderId
  name: string
  open: boolean
  onClose: () => void
}) {
  const hub = useHub()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await hub.disconnectProvider(provider)
      toast.show({ title: `Disconnected ${name}` })
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      size="sm"
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setError(null)
          onClose()
        }
      }}
      title={`Disconnect ${name}?`}
      description={`The Hub forgets its tokens. Your Sessions on ${name}'s Models can't run a Turn until you connect it again.`}
      footer={
        <>
          <DialogClose>Cancel</DialogClose>
          <Button intent="danger" loading={busy} onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </>
      }
    >
      {error && (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      )}
    </Dialog>
  )
}

/**
 * Keeps the focus in `ref` when what had it there goes, as the Sign in button does when the
 * sign-in's steps take its place, and they do when it ends: it moves to the first control left.
 */
function useFocusKept(ref: RefObject<HTMLElement | null>) {
  const within = useRef(false)
  useEffect(() => {
    const region = ref.current
    if (region === null) return
    const focusIn = () => {
      within.current = true
    }
    const focusOut = (event: FocusEvent) => {
      // Moved elsewhere on the page. A control that goes takes the focus nowhere.
      if (event.relatedTarget instanceof Node && !region.contains(event.relatedTarget))
        within.current = false
    }
    region.addEventListener("focusin", focusIn)
    region.addEventListener("focusout", focusOut)
    return () => {
      region.removeEventListener("focusin", focusIn)
      region.removeEventListener("focusout", focusOut)
    }
  }, [ref])
  useEffect(() => {
    const region = ref.current
    if (!within.current || region === null) return
    const active = document.activeElement
    if (active !== null && active !== document.body) {
      if (!region.contains(active)) within.current = false
      return
    }
    region.querySelector<HTMLElement>("button:not(:disabled), a[href], input")?.focus()
  })
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
