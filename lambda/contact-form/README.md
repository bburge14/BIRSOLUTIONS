# Contact form Lambda -- setup

Replaces EmailJS (ran in the browser) and Web3Forms (a third-party relay)
with a direct AWS SES send. The site (`../index.html`) is 100% static
(GitHub Pages, see `/CNAME`) and can't run server-side code itself, so this
Lambda + API Gateway is what actually sends the email -- the static site
just calls it over HTTP.

Everything below is a one-time setup you do in the AWS Console (or AWS CLI
if you'd rather). I can't provision AWS resources myself, only write the
code that runs once you've created them.

## 1. Verify contact@birsolutions.net in SES (skip if already done)

You should already have this from the intake-agent's AWS SES setup
(SETUP.md in birsolutions-intake-agent) -- same verified identity works
here, no separate verification needed. If SES is still in sandbox mode,
move it to production access (SES console -> Account dashboard -> Request
production access) -- sandbox mode can only send *to* verified addresses,
and this Lambda always sends to `contact@birsolutions.net`, so if that
address itself is verified, sandbox mode is actually fine for this
specific use case (unlike sending to arbitrary customer addresses).

## 2. Create the Lambda function

1. Lambda console -> Create function -> Author from scratch.
2. Runtime: **Node.js 20.x** (or 18.x -- both support everything this code
   uses). Architecture: arm64 (cheaper) or x86_64, either is fine.
3. Once created, either:
   - **Paste directly**: open the code editor, replace the default
     `index.mjs` with this folder's `index.mjs`. Recent Node Lambda
     runtimes bundle the AWS SDK v3 (including `@aws-sdk/client-ses`) in
     the runtime image already, so this often works with zero extra
     steps.
   - **Upload a zip** (more reliable if the bundled SDK version ever
     mismatches): in this folder, run `npm install` then zip
     `index.mjs`, `package.json`, and `node_modules/` together, upload
     that zip.
4. Set the handler to `index.handler` (should be the default).
5. Environment variables (Configuration -> Environment variables):
   - `ALLOWED_ORIGIN` = `https://birsolutions.net`
   - `AWS_REGION` -- **don't set this one**, Lambda provides it
     automatically to match whatever region the function itself is
     deployed in.

## 3. Attach SES permission to the Lambda's execution role

Configuration -> Permissions -> click the execution role name (opens IAM).
Add an inline policy using `iam-policy.json` from this folder (or
Add permissions -> Create inline policy -> JSON tab -> paste it in).
The AWS-managed `AWSLambdaBasicExecutionRole` (for CloudWatch logging)
should already be attached from function creation -- leave that as-is.

## 4. Create the API Gateway route

1. API Gateway console -> Create API -> **HTTP API** (not REST API --
   simpler and cheaper for this).
2. Add integration: Lambda, select the function above.
3. Add route: `POST /contact`, wired to that integration.
4. CORS: API Gateway console -> your API -> CORS -> configure:
   - Access-Control-Allow-Origin: `https://birsolutions.net`
   - Access-Control-Allow-Methods: `POST, OPTIONS`
   - Access-Control-Allow-Headers: `Content-Type`
   (The Lambda code also sends these headers itself as a second line of
   defense, but configuring it at the gateway avoids relying on that.)
5. Deploy (HTTP APIs auto-deploy to a `$default` stage by default).
6. Copy the **Invoke URL** -- looks like
   `https://abc123xyz.execute-api.us-east-2.amazonaws.com`.

## 5. Wire the frontend up

In `../index.html`, find `CONTACT_API_URL` near the bottom of the file and
replace the placeholder with `<your invoke URL>/contact`. Commit and push
-- GitHub Pages redeploys automatically.

## 6. Test it

Submit the live form once, confirm the notification lands in
contact@birsolutions.net with Reply-To set to whatever email you tested
with. Check CloudWatch Logs (Lambda console -> Monitor -> View CloudWatch
logs) if it doesn't show up -- SES send failures land there.
