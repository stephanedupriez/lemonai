/** @type {import('types/Tool').Tool} */
const ReadUrlTool = {
  name: "read_url",
  description: `Use this tool to retrieve and return the content of a web page from its URL`,
  params: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "The URL of the web page to retrieve.",
      },
    },
    required: ["url"],
  },

  getActionDescription({ url }) {
    return `Read URL "${url}"`;
  },
};

module.exports = ReadUrlTool;
