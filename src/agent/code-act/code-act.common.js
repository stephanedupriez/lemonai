const Message = require("@src/utils/message");

const finish_action = async (action, context, task_id) => {
  const { memory, onTokenStream } = context;
  const memorized_content = await memory.getMemorizedContent();

  // Enforce an explicit goal status on <finish>.
  // This allows the orchestrator to propagate === Error Feedback === only when the model
  // explicitly declares it failed the current goal.
  const finishStatusRaw = action?.params?.status;
  const finishStatus = typeof finishStatusRaw === "string" ? finishStatusRaw.trim().toUpperCase() : "";

  // Only accept SUCCESS / FAILED.
  if (finishStatus !== "SUCCESS" && finishStatus !== "FAILED") {
    const invalid = finishStatusRaw === undefined ? "(missing)" : JSON.stringify(finishStatusRaw);
    const comments =
      `Invalid finish.status. Expected "SUCCESS" or "FAILED", got: ${invalid}. ` +
      `Emit <finish> with params.status="SUCCESS" or params.status="FAILED".`;

    const result = {
      status: "failure",
      comments,
      content: action?.params?.message || "",
      memorized: memorized_content,
      meta: {
        action_type: "finish",
        finish_status: finishStatusRaw,
        finish_status_valid: false,
      },
      timestamp: new Date().valueOf(),
    };

    const msg = Message.format({
      status: "failure",
      task_id: task_id,
      action_type: "finish",
      content: result.content,
      comments: result.comments,
      memorized: result.memorized,
    });
    onTokenStream && onTokenStream(msg);
    await Message.saveToDB(msg, context.conversation_id);
    return result;
  }

  // If the model explicitly reports SUCCESS, clear any stale error feedback so it won't be
  // re-injected into the next task goal prompt.
  if (finishStatus === "SUCCESS") {
    if (Object.prototype.hasOwnProperty.call(context, "reflection")) {
      context.reflection = "";
    }
  }

  const result = {
    // If the model says FAILED, we return a failure so that the next turn receives
    // the error feedback through the existing reflection mechanism.
    status: finishStatus === "FAILED" ? "failure" : "success",
    comments: finishStatus === "FAILED" ? "Task Failed (explicit)." : "Task Success !",
    content: action.params.message,
    memorized: memorized_content,
    meta: {
      action_type: "finish",
      finish_status: finishStatus,
      finish_status_valid: true,
    },
    timestamp: new Date().valueOf()
  };
  const msg = Message.format({ status: result.status, task_id: task_id, action_type: 'finish', content: result.content, comments: result.comments, memorized: result.memorized });
  onTokenStream && onTokenStream(msg);
  await Message.saveToDB(msg, context.conversation_id);
  return result;
}

/**
 * Helper function to handle retry logic
 * @param {number} retryCount - Current consecutive retry count
 * @param {number} totalRetryAttempts - Current total retry attempts
 * @param {number} maxRetries - Maximum consecutive retry count
 * @param {number} maxTotalRetries - Maximum total retry attempts
 * @param {string} errorMessage - Error message (optional)
 *
 * NOTE: maxTotalRetries is intentionally NOT enforced (global cutoff disabled).
 *       totalRetryAttempts remains useful for cumulative logging/debugging.
 * @returns {Object} - Contains whether to continue retrying and error result (if termination is needed)
 */
const retryHandle = (retryCount, totalRetryAttempts, maxRetries, maxTotalRetries, errorMessage = "") => {
  // check if max consecutive retry times is reached
  if (retryCount >= maxRetries) {
    return {
      shouldContinue: false,
      result: {
        status: "failure",
        comments: `Reached the maximum number of consecutive ${errorMessage ? "exceptions" : "execution failures"} (${maxRetries})${errorMessage ? ": " + errorMessage : ""}`,
      },
    };
  }
  // maxTotalRetries (global cutoff) intentionally disabled: never stop on totalRetryAttempts
  // can continue retry
  return { shouldContinue: true };
};

module.exports = exports = {
  finish_action,
  retryHandle,
};
