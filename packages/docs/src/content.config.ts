import { docsSchema } from "@astrojs/starlight/schema"
import { defineCollection } from "astro:content"
import { docsWithRepoFiles } from "./loaders/repoDocs.ts"

export const collections = {
  docs: defineCollection({ loader: docsWithRepoFiles(), schema: docsSchema() }),
}
