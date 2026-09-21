import { describe, expect, test } from "vitest";
import { routeDiscordMessage } from "./commandRouter.js";

describe("devlog command routing", () => {
  test("routes devlog run as a dedicated authorized action", () => {
    const result = routeDiscordMessage({
      channelMode: "session-linked",
      content: "devlog run",
      userRoleIds: ["admin"],
      allowedRoleIds: ["admin"],
    });

    expect(result).toEqual({ type: "devlog-run" });
  });

  test("does not expose the dedicated action to unauthorized users", () => {
    const result = routeDiscordMessage({
      channelMode: "session-linked",
      content: "devlog run",
      userRoleIds: ["guest"],
      allowedRoleIds: ["admin"],
    });

    expect(result.type).toBe("denied");
  });
});
