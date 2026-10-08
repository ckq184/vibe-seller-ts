---
name: noon-fbn
description: Noon FBN 报表导出与对账流程
requires:
  - noon-shared
review:
  checks:
    - scripts/check_fee_rows.py
  evidence:
    - "reports/**/*.csv"
  criteria: ASN 必须真实出现在列表；四份财务报告每国每月各一份
---
FBN 报表导出流程：

1. 进入 Reports 页签，选择 FBN Inventory / FBN Financial。
2. 每国每月各导出一份，保存到 `store-data/noon-sg/reports/{YYYY-MM}/`。
3. 金额对账公式：`sum(charged_amount) × (1 + VAT) = balance_transfer`。
4. 空报告必须分类标注，不允许静默跳过。
