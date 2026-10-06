// What the Hub keeps by Repo in memory, keyed so that every spelling of a Repo's name finds the
// same entry (#197): GitHub's names ignore case. Each entry keeps the spelling it was first set
// with, which iterating gives back.

import { repoKey } from "@claude-hub/protocol"

/** A Map by Repo whose names match ignoring case. */
export class RepoMap<V> implements ReadonlyMap<string, V> {
  readonly #entries = new Map<string, readonly [repo: string, value: V]>()

  constructor(entries: Iterable<readonly [string, V]> = []) {
    for (const [repo, value] of entries) this.set(repo, value)
  }

  get size() {
    return this.#entries.size
  }

  get(repo: string): V | undefined {
    return this.#entries.get(repoKey(repo))?.[1]
  }

  has(repo: string): boolean {
    return this.#entries.has(repoKey(repo))
  }

  set(repo: string, value: V): this {
    const key = repoKey(repo)
    this.#entries.set(key, [this.#entries.get(key)?.[0] ?? repo, value])
    return this
  }

  delete(repo: string): boolean {
    return this.#entries.delete(repoKey(repo))
  }

  clear(): void {
    this.#entries.clear()
  }

  *entries(): MapIterator<[string, V]> {
    for (const [repo, value] of this.#entries.values()) yield [repo, value]
  }

  *keys(): MapIterator<string> {
    for (const [repo] of this.#entries.values()) yield repo
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.#entries.values()) yield value
  }

  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries()
  }

  forEach(callback: (value: V, repo: string, map: ReadonlyMap<string, V>) => void): void {
    for (const [repo, value] of this.entries()) callback(value, repo, this)
  }
}

/** Each Repo among `repos` once, by the first spelling of it there. */
export const uniqueRepos = (repos: Iterable<string>): Array<string> => [
  ...new RepoMap([...repos].map((repo) => [repo, true] as const)).keys(),
]
