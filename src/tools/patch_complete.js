// app/src/tools/patch_complete.js
//Tool definition for the local orchestrator action <patch_complete><message>...</message></patch_complete>
 
 const PatchComplete = {
   name: "patch_complete",
   description:
     "Marks the end of a problem-resolution attempt. Use this tool when you believe the issue has been resolved and you are ready to proceed to validation/next steps. " +
     "You MUST include a short <message> explaining what was done and why. " +
     "IMPORTANT: output ONLY the single XML tool call <patch_complete>...</patch_complete> with no other text, no explanation, and no additional XML tags outside this tool call.\n\n" +
     "Example: <patch_complete><message><![CDATA[Resolved the failure by adjusting X to handle Y; ready to validate.]]></message></patch_complete>",
   params: {
     type: "object",
     properties: {
       message: {
         type: "string",
         description: "Short explanation of what was changed and why (free-form text).",
       },
     },
     required: ["message"],
     additionalProperties: false,
   },
   getActionDescription() {
    return "Mark modifications complete and proceed to validation";
   },
 };
 
 module.exports = PatchComplete;
