import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const base = process.env.PI_CONTEXTIMATE_PAYLOAD_CAPTURE ?? process.env.PI_CONTEXTIMATE_ABLATION_CAPTURE;
  if (!base) return;
  pi.on("before_provider_request", (event) => {
    appendFileSync(`${base}.payloads.jsonl`, `${JSON.stringify(event.payload)}\n`, "utf8");
  });
}
