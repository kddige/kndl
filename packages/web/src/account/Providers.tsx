// The signed-in person's Connected providers (ADR 0029), on the Account page beside their Claude
// credential: for each Provider the Hub can connect, its subscription sign-in and an API key field,
// or, once connected, the account, its Models and when they were checked. The Hub runs each
// sign-in itself and sends its steps: a page to open, which for ChatGPT's lands on an address on
// the Hub's own machine that won't load here, so its address is pasted back; a code to enter on
// the Provider's page; a choice; or what it is doing. Keys and pasted addresses go to the Hub
// write-only, and are never shown again.

import type { ConnectableProvider, ConnectedProvider, ProviderId, SignInStep } from "@kndl/protocol"
import * as stylex from "@stylexjs/stylex"
import { type FormEvent, type ReactNode, useEffect, useState } from "react"
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
})

/**
 * The Providers heading, with the Claude credential's section (`claude`), the Connected provider
 * for Anthropic, and then a section for each Provider the Hub can connect.
 */
export function ProvidersSection({ claude }: { claude: ReactNode }) {
  const hub = useHub()
  const providers = useHubState((state) => state.providers)
  const [error, setError] = useState<string | null>(null)

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
          Your own accounts, which the Sessions you start run their Models on. Only your Sessions
          use them, and only you drive those.
        </p>
      </div>
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
        providers.connectable.map((connectable) => (
          <ProviderCard
            key={connectable.provider}
            connectable={connectable}
            connected={providers.connected.find((each) => each.provider === connectable.provider)}
          />
        ))
      )}
    </section>
  )
}

/** One Provider: how to connect it, or what is connected, and its sign-in while one runs. */
function ProviderCard({
  connectable,
  connected,
}: {
  connectable: ConnectableProvider
  connected: ConnectedProvider | undefined
}) {
  const hub = useHub()
  const { provider, name } = connectable
  const signIn = useHubState((state) => (state.signIn?.provider === provider ? state.signIn : null))
  const [replacing, setReplacing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const titleId = `provider-${provider}`
  const signingIn = signIn !== null && signIn.ended === null

  const startSignIn = () => {
    setStartError(null)
    // The last one's outcome goes: the store then follows this one.
    hub.clearSignIn()
    hub.startSignIn(provider).then(
      (ended) => {
        if (ended.outcome !== "Connected") return
        setReplacing(false)
        hub.clearSignIn(ended.requestId)
        toast.show({ title: `Connected ${name}` })
      },
      // The store holds why a sign-in it follows failed; this is one that was never sent.
      (cause: unknown) => {
        if (hub.getState().signIn === null) setStartError(messageOf(cause))
      },
    )
  }

  return (
    <section aria-labelledby={titleId} {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.sectionHead)}>
        <h3 id={titleId} {...stylex.props(styles.sectionTitle)}>
          {name}
        </h3>
        <p {...stylex.props(styles.note)}>{noteFor(connectable)}</p>
      </div>
      {signingIn ? (
        <SignInSteps name={name} signIn={signIn} />
      ) : connected !== undefined && !replacing ? (
        <Connection
          name={name}
          connected={connected}
          onReplace={() => setReplacing(true)}
          onDisconnect={() => setDisconnecting(true)}
        />
      ) : (
        <>
          {signIn?.ended?.outcome === "Failed" && (
            <Banner intent="danger" icon={<WarningIcon />} title="The sign-in failed">
              {signIn.ended.message}
            </Banner>
          )}
          <Connect
            connectable={connectable}
            replacing={connected !== undefined}
            onSignIn={startSignIn}
            signInError={startError}
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
          {connected.modelsProblem} These are from the last check that worked.
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

/** The Provider's sign-in, and a form to paste an API key: either connects it. */
function Connect({
  connectable,
  replacing,
  onSignIn,
  signInError,
  onDone,
}: {
  connectable: ConnectableProvider
  replacing: boolean
  onSignIn: () => void
  signInError: string | null
  onDone: () => void
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
    <>
      {connectable.signIn !== undefined && (
        <div {...stylex.props(styles.actions)}>
          <Button intent="primary" onClick={onSignIn}>
            {connectable.signIn}
          </Button>
          {replacing && !connectable.apiKey && (
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
        <form onSubmit={submit} noValidate {...stylex.props(styles.form)}>
          <Field
            label="API key"
            description={`Checked with ${name} as it is saved. It is stored encrypted and never shown again.`}
            invalid={touched && empty}
            error={touched && empty ? "Paste a key." : undefined}
          >
            <Input
              type="password"
              value={apiKey}
              autoComplete="off"
              onValueChange={(next: string) => setApiKey(next)}
              spellCheck={false}
              autoCapitalize="off"
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
            {replacing && (
              <Button intent="ghost" onClick={onDone} disabled={busy}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      )}
    </>
  )
}

/**
 * A sign-in in progress, as far as the Hub's steps go: the page to open, or the code to enter
 * there; then what it asks, a paste or a choice, or what it is doing; and Cancel.
 */
function SignInSteps({ name, signIn }: { name: string; signIn: SignInProgress }) {
  const hub = useHub()
  // How many steps had come when the last answer was sent: it is asked again only by a new one.
  const [answeredAt, setAnsweredAt] = useState(-1)
  const { steps } = signIn
  const page = steps.findLast((step) => step._tag === "OpenUrl" || step._tag === "EnterCode")
  const last = steps.at(-1)
  const asking = steps.length > answeredAt && (last?._tag === "Paste" || last?._tag === "Choose")
  const progress = last?._tag === "Progress" ? last.message : undefined

  const answer = (value: string) => {
    if (hub.answerSignIn(value)) setAnsweredAt(steps.length)
  }

  return (
    <div aria-label={`Signing in to ${name}`} {...stylex.props(styles.signIn)}>
      {page?._tag === "OpenUrl" && (
        <>
          {page.instructions !== undefined && page.instructions !== "" && (
            <p {...stylex.props(styles.note)}>{page.instructions}</p>
          )}
          <PageLink url={page.url} />
        </>
      )}
      {page?._tag === "EnterCode" && (
        <>
          <p {...stylex.props(styles.note)}>Open {name}'s page, and enter this code there:</p>
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
      {asking && last?._tag === "Paste" && (
        <PasteForm
          step={last}
          afterPage={page?._tag === "OpenUrl"}
          onAnswer={answer}
          key={steps.length}
        />
      )}
      {asking && last?._tag === "Choose" && (
        <div {...stylex.props(styles.form)}>
          <p {...stylex.props(styles.note)}>{last.message}</p>
          <div {...stylex.props(styles.actions)}>
            {last.options.map((option) => (
              <Button key={option.id} size="sm" onClick={() => answer(option.id)}>
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      )}
      {!asking && (
        <div role="status" {...stylex.props(styles.progress)}>
          <Spinner size="sm" />
          <span>{progress ?? `Waiting for ${name}…`}</span>
        </div>
      )}
      <div {...stylex.props(styles.actions)}>
        <Button size="sm" intent="ghost" onClick={() => hub.cancelSignIn()}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** The Provider's sign-in page, in a new tab. */
function PageLink({ url }: { url: string }) {
  return (
    <div {...stylex.props(styles.actions)}>
      <Button
        intent="primary"
        size="sm"
        nativeButton={false}
        render={<a href={url} target="_blank" rel="noreferrer noopener" />}
      >
        Open the sign-in page
        <ExternalLinkIcon aria-hidden="true" />
      </Button>
    </div>
  )
}

/**
 * A Paste step's box. After a page to open, it is for the address the browser landed on: ChatGPT's
 * sign-in sends it to the Hub's own machine, which doesn't load from here.
 */
function PasteForm({
  step,
  afterPage,
  onAnswer,
}: {
  step: Extract<SignInStep, { _tag: "Paste" }>
  afterPage: boolean
  onAnswer: (value: string) => void
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
        label={afterPage ? "Paste the address the page you landed on shows" : step.message}
        description={
          afterPage
            ? "Once you've signed in, your browser goes to a page that may not load. That's expected: copy its address from the address bar."
            : undefined
        }
      >
        <Input
          value={value}
          autoComplete="off"
          onValueChange={(next: string) => setValue(next)}
          {...(step.placeholder !== undefined && { placeholder: step.placeholder })}
          spellCheck={false}
          autoCapitalize="off"
          autoFocus
          sx={styles.mono}
        />
      </Field>
      <div {...stylex.props(styles.actions)}>
        <Button type="submit" size="sm" disabled={empty}>
          Continue
        </Button>
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

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
