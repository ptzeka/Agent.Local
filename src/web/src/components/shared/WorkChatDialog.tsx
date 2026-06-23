import { useCallback, useEffect, useRef, useState } from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import Stack from "@mui/material/Stack";
import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import CircularProgress from "@mui/material/CircularProgress";
import CloseIcon from "@mui/icons-material/Close";
import { useAgentCliApi } from "./agentCliApi";

// one rendered bubble. `streaming` marks the assistant bubble currently being painted by delta frames — the next
// delta appends to it, an `end` frame closes it. A closed bubble is never appended to again.
interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

// the mini chat over a work's interactive cli session. The EventSource (the read channel) is opened on chat-open
// and closed on chat-close — nothing streams while the dialog is shut. Input goes out over the sender (POST); the
// answer comes back as delta/end frames the state machine below appends verbatim. Stop cancels the live turn.
export default function WorkChatDialog({
  workId,
  title,
  open,
  onClose,
}: {
  workId: string;
  title: string;
  open: boolean;
  onClose: () => void;
}) {
  const api = useAgentCliApi();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [draft, setDraft] = useState("");
  const [ready, setReady] = useState(false); // the stream has attached (ready frame) — input is usable
  const [busy, setBusy] = useState(false); // a turn is in flight (between turn start/done) — show Stop
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // append a raw delta fragment verbatim to the open assistant bubble (token boundaries are arbitrary, so never
  // insert separators); open a new bubble when none is streaming. Embedded newlines ride in the content.
  const appendDelta = useCallback((content: string) => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { ...last, content: last.content + content }];
      }
      return [...prev, { role: "assistant", content, streaming: true }];
    });
  }, []);

  // close the streaming bubble: the next delta starts a fresh one
  const closeStream = useCallback(() => {
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        return [...prev.slice(0, -1), { ...last, streaming: false }];
      }
      return prev;
    });
  }, []);

  // open the live stream on chat-open; tear it down on close/unmount. Provision is async, so a `cancelled` guard
  // drops a stream that resolved after the dialog already closed.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let source: EventSource | null = null;
    setMessages([]);
    setReady(false);
    setBusy(false);
    setError(null);

    void (async () => {
      try {
        await api.provisionSession(workId);
      } catch (err) {
        if (!cancelled) setError(`could not open chat: ${String(err)}`);
        return;
      }
      if (cancelled) return;
      // withCredentials so the same-origin session cookie authenticates the stream (EventSource sets no headers)
      source = new EventSource(api.streamUrl(workId), { withCredentials: true });
      source.addEventListener("ready", () => setReady(true));
      source.addEventListener("turn", (e) => {
        const { status } = JSON.parse((e as MessageEvent).data) as { status: "start" | "done" };
        setBusy(status === "start");
        if (status === "done") closeStream(); // belt-and-suspenders: never leave a bubble open past the turn
      });
      source.addEventListener("delta", (e) => {
        const { content } = JSON.parse((e as MessageEvent).data) as { content: string };
        appendDelta(content);
      });
      source.addEventListener("end", () => closeStream());
      source.addEventListener("message", (e) => {
        const { content } = JSON.parse((e as MessageEvent).data) as { content: string };
        setMessages((prev) => [...prev, { role: "assistant", content }]);
      });
      // EventSource auto-reconnects on transient drops; only surface a hard failure once the stream is unusable
      source.onerror = () => {
        if (source?.readyState === EventSource.CLOSED) setError("chat stream disconnected");
      };
    })();

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [open, workId, api, appendDelta, closeStream]);

  // keep the latest message in view as the transcript grows
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || busy) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setDraft("");
    void api.sendInput(workId, text).catch((err) => setError(`send failed: ${String(err)}`));
  }, [draft, busy, api, workId]);

  const stop = useCallback(() => {
    void api.stop(workId).catch((err) => setError(`stop failed: ${String(err)}`));
  }, [api, workId]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", pr: 1 }}>
        Chat · {title}
        <IconButton onClick={onClose} size="small" aria-label="close">
          <CloseIcon fontSize="small" />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1}>
          <Box sx={{ height: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 1, pr: 1 }}>
            {messages.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ m: "auto" }}>
                {ready ? "Say something to the agent." : "Connecting…"}
              </Typography>
            ) : (
              messages.map((m, i) => (
                <Paper
                  key={i}
                  variant="outlined"
                  sx={{
                    px: 1.5,
                    py: 1,
                    maxWidth: "85%",
                    alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                    bgcolor: m.role === "user" ? "primary.main" : "background.paper",
                    color: m.role === "user" ? "primary.contrastText" : "text.primary",
                  }}
                >
                  {/* pre-wrap preserves the model's own newlines while still wrapping long lines */}
                  <Typography variant="body2" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {m.content}
                  </Typography>
                </Paper>
              ))
            )}
            <div ref={bottomRef} />
          </Box>

          {error && (
            <Typography variant="caption" color="error">
              {error}
            </Typography>
          )}

          <Stack direction="row" spacing={1} alignItems="flex-end">
            <TextField
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends, Shift+Enter inserts a newline
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={ready ? "Message the agent…" : "Connecting…"}
              size="small"
              fullWidth
              multiline
              maxRows={4}
              disabled={!ready}
            />
            {busy ? (
              <Button onClick={stop} variant="outlined" color="warning" startIcon={<CircularProgress size={14} />}>
                Stop
              </Button>
            ) : (
              <Button onClick={send} variant="contained" disabled={!ready || draft.trim().length === 0}>
                Send
              </Button>
            )}
          </Stack>
        </Stack>
      </DialogContent>
    </Dialog>
  );
}
