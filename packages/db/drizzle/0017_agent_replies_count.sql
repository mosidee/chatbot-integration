-- An agent's reply now moves conversations.last_message_at, as an inbound message and an AI
-- reply already did. Bring conversations forward to their newest agent reply, so the inbox
-- stops treating ones an agent already answered as waiting. Only ever moves the value later,
-- so a second run changes nothing.
UPDATE "conversations" AS c
SET "last_message_at" = h.latest
FROM (
  SELECT "conversation_id", max("created_at") AS latest
  FROM "messages"
  WHERE "sender_type" = 'human' AND "direction" = 'outbound'
  GROUP BY "conversation_id"
) AS h
WHERE h."conversation_id" = c."id"
  AND (c."last_message_at" IS NULL OR c."last_message_at" < h.latest);
