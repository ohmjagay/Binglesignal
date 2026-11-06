# Forward-to-Brief setup

Forward-to-Brief gives each account a random private address. It only processes messages the user chooses to forward; it does not connect to or scan the user's mailbox. The Worker accepts messages up to 1 MB, enforces a 100-message daily cap, encrypts the resulting brief, and does not retain the raw message. Gmail confirmation codes are encrypted and can be retrieved once from the Email tab.

## One-time setup

1. **Apply the database migration.** Open the Supabase project → **SQL Editor** → **New query**. Open `supabase/006_forward_to_brief.sql` in VS Code, copy the entire file, paste it into the SQL Editor, and select **Run**.
2. **Create a narrowly scoped Cloudflare API token.** In Cloudflare, select your profile icon → **My Profile** → **API Tokens** → **Create Token** → **Create Custom Token**. Add the permission **Zone → Email Routing Rules → Edit** (Cloudflare API permission name: `Email Routing Rules Write`), and limit **Zone Resources** to `binglesignal.com`. Select **Continue to summary** → **Create Token**, then copy the token; Cloudflare only shows it once.
3. **Add the Cloudflare Worker settings.** Open **Workers & Pages** → **binglesignal** → **Settings** → **Variables and Secrets**. Add:
   - Plain-text `EMAIL_BETA_ENABLED` = `true` (keep this emergency switch; set it back to `false` to stop forwarding).
   - Plain-text `EMAIL_FORWARD_DOMAIN` = `in.binglesignal.com`.
   - Plain-text `CF_ZONE_ID` = the Zone ID shown on the Cloudflare **binglesignal.com** overview page.
   - Plain-text `CF_EMAIL_WORKER_NAME` = `binglesignal`.
   - Secret `CF_EMAIL_ROUTING_TOKEN` = the API token copied in step 2.
4. **Check the receiving-domain DNS before changing it.** Cloudflare's documented Email Routing onboarding manages MX records at the root of the domain. If `binglesignal.com` already receives business email through another provider, do not onboard it or change its root MX records without first arranging equivalent routes for that mail. Cloudflare's documented catch-all rule only supports apex domains; it does not support a catch-all on `in.binglesignal.com`. BingleSignal therefore creates one exact Cloudflare Worker rule per generated address through the API. The receiving address domain still needs to accept mail through Cloudflare; confirm the correct DNS configuration for `in.binglesignal.com` in the Cloudflare Email Routing settings before proceeding.
5. **Deploy the Worker** from VS Code → **Terminal** → **New Terminal**:

   ```text
   npm run deploy
   ```

6. Open **Compute** → **Email Service** → **Email Routing** → **Routing Rules**. Do not enable a catch-all rule. When a user creates an address in BingleSignal, the Worker registers an exact `local-part@in.binglesignal.com` rule targeting the `binglesignal` Worker. If the account does not support mail delivery to that subdomain, stop here; do not replace the address with `@binglesignal.com` unless the root-domain mail setup has been reviewed.

The forwarding rule API token is used only to create and remove exact rules. The Worker refuses to overwrite an existing rule that targets a different destination, and the privacy-delete action attempts to remove the user's exact rule before deleting their address data.

## User setup

1. Sign in to BingleSignal and open **Email**.
2. Select **Create my private address** and copy the generated address.
3. In Gmail, open **Settings** → **See all settings** → **Forwarding and POP/IMAP** → **Add a forwarding address**. Paste the private address. When Gmail emails its confirmation code, return to BingleSignal → **Email** → **Show Gmail confirmation code once**, then enter that code in Gmail.
4. In Gmail, open **Filters and Blocked Addresses** → **Create a new filter**. Set criteria for the messages to forward (for example, `category:promotions OR category:social OR category:updates`), choose **Forward it to**, and save the filter.
5. In Outlook, open **Settings** → **Mail** → **Rules** → **Add new rule**. Choose the messages to forward, choose **Forward to**, paste the private address, and save. Some organization-managed Microsoft 365 mailboxes block forwarding outside the organization.
6. Forwarded briefs appear in the Email tab. Scheduled outbound email delivery is implemented separately in T8; until then the brief is available in the app.

An unrecognized address, a DMARC failure reported by Cloudflare, a message over 1 MB, or an address over its daily cap is rejected. Cloudflare's trusted `Authentication-Results` header is used for DMARC rejection; other senders' authentication headers are not trusted.
