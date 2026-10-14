import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { ChartBarIcon } from "@heroicons/react/24/outline";
import { useState, type FormEvent } from "react";

import { errorMessageOf, type Session } from "./session.js";
import { styles } from "./styles.js";

type AuthMode = "login" | "register" | "token";

export function LoginPage({
  notice,
  onLogin,
}: {
  notice: string | undefined;
  onLogin: (session: Session) => void;
}) {
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tokenTenant, setTokenTenant] = useState("local");
  const [tokenValue, setTokenValue] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [authing, setAuthing] = useState(false);

  async function submitAuth(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authing) {
      return;
    }
    if (authMode === "token") {
      const nextTenant = tokenTenant.trim();
      const nextToken = tokenValue.trim();
      if (nextTenant === "" || nextToken === "") {
        setError("租户与访问 token 都要填写。");
        return;
      }
      onLogin({ token: nextToken, tenantId: nextTenant });
      return;
    }
    setAuthing(true);
    setError(undefined);
    try {
      if (authMode === "register") {
        const registered = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: email.trim(), password }),
        });
        if (!registered.ok) {
          setError(await errorMessageOf(registered));
          return;
        }
      }
      const logged = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      if (!logged.ok) {
        setError(await errorMessageOf(logged));
        return;
      }
      const body = (await logged.json()) as { token: string; tenantId: string };
      onLogin({ token: body.token, tenantId: body.tenantId, email: email.trim().toLowerCase() });
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : "登录请求失败。");
    } finally {
      setAuthing(false);
    }
  }

  return (
    <Center axis="both" padding={4} minHeight="100dvh" xstyle={styles.loginPage}>
      <Stack gap={6} align="stretch" width="100%" maxWidth="28rem">
        <Stack direction="horizontal" gap={2} align="center" justify="center">
          <Icon icon={ChartBarIcon} size="lg" />
          <Text type="large" weight="semibold">
            Crypto Research
          </Text>
        </Stack>
        <Card width="100%" xstyle={styles.loginCard}>
          <Stack gap={6} align="stretch">
            <Stack gap={2}>
              <Heading level={1}>
                {authMode === "register" ? "创建研究账号" : "继续你的研究"}
              </Heading>
              <Text as="p" color="secondary">
                登录后查看历史会话，开始新的研究。
              </Text>
            </Stack>
            <SegmentedControl
              label="登录方式"
              value={authMode}
              onChange={(value) => {
                setAuthMode(value as AuthMode);
                setError(undefined);
              }}
            >
              <SegmentedControlItem value="login" label="登录" />
              <SegmentedControlItem value="register" label="注册" />
              <SegmentedControlItem value="token" label="访问令牌" />
            </SegmentedControl>
            <form onSubmit={submitAuth}>
              <Stack gap={4}>
                {authMode === "token" ? (
                  <>
                    <TextInput
                      label="租户"
                      autoComplete="off"
                      value={tokenTenant}
                      onChange={(value) => setTokenTenant(value)}
                    />
                    <TextInput
                      label="访问 token"
                      type="password"
                      autoComplete="off"
                      value={tokenValue}
                      onChange={(value) => setTokenValue(value)}
                    />
                  </>
                ) : (
                  <>
                    <TextInput
                      label="邮箱"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(value) => setEmail(value)}
                    />
                    <TextInput
                      label="密码"
                      type="password"
                      autoComplete={authMode === "login" ? "current-password" : "new-password"}
                      value={password}
                      onChange={(value) => setPassword(value)}
                    />
                  </>
                )}
                <Button
                  type="submit"
                  variant="primary"
                  width="100%"
                  isLoading={authing}
                  isDisabled={authing}
                  label={
                    authMode === "register" ? "注册并登录" : authMode === "login" ? "登录" : "进入"
                  }
                />
                {error !== undefined ? (
                  <Banner role="alert" status="error" title="登录失败" description={error} />
                ) : null}
              </Stack>
            </form>
          </Stack>
        </Card>
        {notice !== undefined ? <Banner role="status" status="warning" title={notice} /> : null}
      </Stack>
    </Center>
  );
}
