# 嵌入式项目约束（所有 BMAD agent 必读）

> 通过 `_bmad/custom/*.toml` 的 `persistent_facts` 注入，PM、架构、拆分、开发各阶段都会自动加载。
> 换项目时只需要改本文件。

## 目标平台
- MCU：STM32F103C8T6（Cortex-M3，72 MHz，Flash 64 KB，SRAM 20 KB，无 FPU）
- RTOS：FreeRTOS 10.x，静态分配（`configSUPPORT_DYNAMIC_ALLOCATION = 0`）
- 工具链：arm-none-eabi-gcc 13+，CMake；HAL 用 STM32CubeF1 LL 库
- 宿主测试：本机 gcc + Unity（ThrowTheSwitch），`make -C test` 一键运行

## 资源预算（超出必须在架构文档里登记并说明）
- Flash ≤ 48 KB（留 25% 余量给 OTA/升级），SRAM ≤ 15 KB
- 每个任务栈在架构文档里显式给定，并开启 `uxTaskGetStackHighWaterMark` 检查
- 控制环 1 s 周期抖动 ≤ 10 ms

## 硬规则（违反即 review 不通过）
1. ISR 里禁止：阻塞调用、`printf`、`malloc`、浮点运算；只允许置标志、写队列（`...FromISR`）、清中断。
2. 全工程禁止动态内存（`malloc/free/new`），对象一律静态分配。
3. 业务逻辑（控制算法、状态机、协议解析）**不得 include 任何 HAL/LL/FreeRTOS 头文件**，只依赖 `port/` 下的纯 C 接口，保证能在 PC 上编译和测试。
4. 禁止浮点：温度一律用 `int16_t`，单位 0.1 ℃（例：`235` = 23.5 ℃）。
5. 共享数据跨任务只能走队列或带互斥的访问函数，禁止裸全局变量。
6. 编码规范：MISRA C:2012 子集（必须项）+ `-Wall -Wextra -Werror`；固定宽度整数（`stdint.h`）。
7. 安全相关输出（加热继电器）必须有独立于主逻辑的看门狗/超温硬保护路径。

## 测试分层（agent 能自动跑的只有前两层）
| 层 | 方式 | 谁执行 |
| --- | --- | --- |
| L1 单元测试 | 宿主 gcc + Unity，纯逻辑模块 | agent，必须通过 |
| L2 静态检查 | `-Werror` + cppcheck | agent，必须通过 |
| L3 交叉编译 + 资源检查 | arm-none-eabi-size 对照预算 | agent（有工具链时） |
| L4 上板 / HIL | 实板、示波器、温箱 | **人工**，Story 验收里单列 |
