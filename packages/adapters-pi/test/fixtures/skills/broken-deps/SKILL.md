---
name: broken-deps
description: 依赖指向不存在技能的反例
requires:
  - not-exist-shared
---
这个技能的 requires 指向一个不存在的技能，用于验证缺失依赖必须被显式报告。
