const ReplaceCodeBlock = {
  name: "replace_code_block",
  description:
    "Replace a localized code passage in a file by providing the final updated snippet (with a small amount of surrounding context).",
  params: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "The path of the file to read.",
      },
      code_block: {
        type: "string",
        description:
          "Updated snippet (single-line or multi-line) including a bit of context before and after the intended modification.",
      },
    },
    required: ["path", "code_block"],
  },
  getActionDescription({ path = "", code_block = "" }) {
    const preview = (code_block || "").replace(/\s+/g, " ").trim().slice(0, 80);
    return `${path}${preview ? `: ${preview}` : ""}`;
  },
};

module.exports = ReplaceCodeBlock;
