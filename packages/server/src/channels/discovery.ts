// IMAP/SMTP 服务器自动发现（域名查表 + 启发式回退）。
// 逐条移植 app/channels/email_discovery.py 的表与语义，source ∈ 'known'|'heuristic'。

const KNOWN_IMAP_SERVERS: Record<string, [string, number]> = {
  // NetEase
  "163.com": ["imap.163.com", 993],
  "126.com": ["imap.126.com", 993],
  "yeah.net": ["imap.yeah.net", 993],
  // Google
  "gmail.com": ["imap.gmail.com", 993],
  "googlemail.com": ["imap.gmail.com", 993],
  // Microsoft
  "outlook.com": ["outlook.office365.com", 993],
  "hotmail.com": ["outlook.office365.com", 993],
  "live.com": ["outlook.office365.com", 993],
  // Chinese providers
  "qq.com": ["imap.qq.com", 993],
  "foxmail.com": ["imap.qq.com", 993],
  "sina.com": ["imap.sina.com", 993],
  "sohu.com": ["imap.sohu.com", 993],
  "aliyun.com": ["imap.aliyun.com", 993],
  // Yahoo
  "yahoo.com": ["imap.mail.yahoo.com", 993],
  "yahoo.co.jp": ["imap.mail.yahoo.co.jp", 993],
};

// use_starttls=true 表示 SMTP+STARTTLS；false 表示 SMTP_SSL。
const KNOWN_SMTP_SERVERS: Record<string, [string, number, boolean]> = {
  "163.com": ["smtp.163.com", 465, false],
  "126.com": ["smtp.126.com", 465, false],
  "yeah.net": ["smtp.yeah.net", 465, false],
  "gmail.com": ["smtp.gmail.com", 587, true],
  "googlemail.com": ["smtp.gmail.com", 587, true],
  "outlook.com": ["smtp.office365.com", 587, true],
  "hotmail.com": ["smtp.office365.com", 587, true],
  "live.com": ["smtp.office365.com", 587, true],
  "qq.com": ["smtp.qq.com", 465, false],
  "foxmail.com": ["smtp.qq.com", 465, false],
  "sina.com": ["smtp.sina.com", 465, false],
  "sohu.com": ["smtp.sohu.com", 465, false],
  "aliyun.com": ["smtp.aliyun.com", 465, false],
  "yahoo.com": ["smtp.mail.yahoo.com", 465, false],
  "yahoo.co.jp": ["smtp.mail.yahoo.co.jp", 465, false],
};

export interface ImapDiscovery {
  imap_host: string;
  imap_port: number;
  source: string;
}

export interface SmtpDiscovery {
  smtp_host: string;
  smtp_port: number;
  smtp_use_starttls: boolean;
  source: string;
}

export function discoverImap(email: string): ImapDiscovery {
  const domain = domainOf(email);
  const entry = KNOWN_IMAP_SERVERS[domain];
  if (entry) return { imap_host: entry[0], imap_port: entry[1], source: "known" };
  return { imap_host: `imap.${domain}`, imap_port: 993, source: "heuristic" };
}

export function discoverSmtp(email: string): SmtpDiscovery {
  const domain = domainOf(email);
  const entry = KNOWN_SMTP_SERVERS[domain];
  if (entry) return { smtp_host: entry[0], smtp_port: entry[1], smtp_use_starttls: entry[2], source: "known" };
  return { smtp_host: `smtp.${domain}`, smtp_port: 465, smtp_use_starttls: false, source: "heuristic" };
}

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return (at === -1 ? email : email.slice(at + 1)).toLowerCase();
}
