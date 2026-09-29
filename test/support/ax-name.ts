import type { PageHandle } from "../../src/engine/types.ts";
import type { CdpClient } from "../../src/browser/cdp/client.ts";

export async function chromeAccessibleName(page: PageHandle, id: string): Promise<string> {
  const internals = page as unknown as {
    browser: { client: CdpClient };
    session: { sessionId: string };
  };
  const { client } = internals.browser;
  const sessionId = internals.session.sessionId;
  const document = await client.call("DOM.getDocument", { depth: -1, pierce: true }, sessionId);
  const find = (node: typeof document.root): number | undefined => {
    const attributes = node.attributes ?? [];
    if (
      attributes.some(
        (value, index) => index % 2 === 0 && value === "id" && attributes[index + 1] === id,
      )
    )
      return node.backendNodeId;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const found = find(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const backendNodeId = find(document.root);
  if (backendNodeId === undefined) throw new Error(`DOM node #${id} not found`);
  const tree = await client.call(
    "Accessibility.getPartialAXTree",
    { backendNodeId, fetchRelatives: false },
    sessionId,
  );
  return String(tree.nodes[0]?.name?.value ?? "");
}
