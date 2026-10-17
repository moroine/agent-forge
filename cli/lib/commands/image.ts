// forge image build|update — délègue au script bash conservé. Voir les
// Non-goals de la spec : forge-image.sh est une séquence de provisioning shell
// envoyée dans un container ; en TypeScript elle deviendrait des template
// strings du même shell, sans gain de lisibilité.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";

export async function cmdImage(ctx: Context, sub: string | undefined, target?: string): Promise<number> {
  if (sub !== "build" && sub !== "update") {
    throw new ForgeError("Usage: forge image build|update [super]");
  }
  if (target !== undefined && target !== "super") {
    throw new ForgeError("Usage: forge image build|update [super]");
  }
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "forge-image.sh");
  // attach, pas exec : le build est long et sa sortie doit défiler en direct.
  const scriptArgs = target ? [sub, target] : [sub];
  return ctx.attach(["bash", script, ...scriptArgs]);
}
