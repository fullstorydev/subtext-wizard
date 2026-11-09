# Identify users

Tie each session to the signed-in user so sessions can be found by user.

1. Find where the authenticated user becomes available on the client: login handler, auth provider, session bootstrap, or similar. Use only data already on the client; don't add API calls.
2. Call `FS('setIdentity')` there, only for signed-in users:

        FS('setIdentity', {
          uid: user.id,
          properties: { displayName: user.name, email: user.email },
        });

   - `uid` is the stable internal user id, never the email.
   - Add other user properties the client already has, if useful.
3. In React, call it inside a `useEffect` keyed on the user, not on every render or at module top level:

        useEffect(() => {
          if (!user) return;
          FS('setIdentity', { uid: user.id, properties: { displayName: user.name, email: user.email } });
        }, [user]);

If you can't find where the user is known, or the app has no sign-in, tell the user and skip this page.

Details: https://subtext.fullstory.com/api/identification.md
