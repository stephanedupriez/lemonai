// lemon-app/app/src/tools/information.js
// Tool definition for the local orchestrator "log only" action:
//   <information><message><![CDATA[...]]></message></information>
//
// This tool MUST NOT trigger any runtime/sandbox execution.
// It exists only so the agent can emit free-form introspection / progress notes
// that remain visible in the message loop and logs.

const Information = {
  name: "information",
  description:
    "Writes a free-form informational note about what you are doing/thinking. " +
    "This tool triggers NO execution: it is only recorded in the conversation history and logs. " +
    "Use it at any time (optionally alongside other tool calls) to expose your current intent, doubts, hypotheses, or blockers. " +
    "The <message> MUST be wrapped in <![CDATA[...]]>.\n\n" +
    "Example: <information><message><![CDATA[I am preparing the test file to validate the changes; I suspect the failure comes from X so I will check Y next.]]></message></information>",
  params: {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: "Free-form informational note (text only). Must be wrapped in CDATA in the XML tool call.",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
  getActionDescription() {
    return "Record an informational note (no-op)";
  },
};

module.exports = Information;
