/** @type {import('types/Tool').Tool} */
const WebSearchTool = {
  name: "web_search",
  description: `Use this tool to search the web for information`,
  params: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "the search key words split with space",
      },
      num_results: {
        type: "integer",
        description: "Optional. The desired number of search results (default: 3).",
      }
    },
    required: ["query"],
  },

  getActionDescription({ query, num_results = 3 }) {
    return `Web search "${query}" (top ${num_results} results)`;
  },
};

module.exports = WebSearchTool;
