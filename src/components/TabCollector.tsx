/**
 * AUDITORIAPLUS+ - Tab 2: Colector de Conteo en Almacén (Depósito 150101)
 * Ergonomía táctil para terminales industriales (Honeywell, Zebra, Smartphones)
 * Mínimo 48px - 56px por botón, contraste extremo, modo offline garantizado.
 */

import React, { useState, useRef, useEffect } from 'react';
import {
  Barcode,
  Search,
  CheckCircle2,
  AlertTriangle,
  Package,
  Plus,
  Minus,
  RotateCcw,
  Zap,
  ArrowRight,
  Wifi,
  WifiOff,
  Database,
  X,
  History,
  Info
} from 'lucide-react';
import { useMissionStore } from '../store/useMissionStore';
import { useDiscrepancyStore } from '../stores/useDiscrepancyStore';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { enqueueOfflineEvent, getOfflineQueueCount } from '../lib/db';
import { normalizeSku, MissionTask, FloorDiscrepancy } from '../types/audit';

interface TabCollectorProps {
  onNavigateToFloor?: () => void;
}

export const TabCollector: React.FC<TabCollectorProps> = ({ onNavigateToFloor }) => {
  const isOnline = useOnlineStatus();

  // Stores
  const {
    activeMissionId,
    activeMission,
    activeTask,
    tasks,
    metrics,
    searchTerm,
    setSearchTerm,
    setActiveTaskBySku,
    updateTaskCountLocally,
    clearActiveTask,
  } = useMissionStore();

  const { addDiscrepancy } = useDiscrepancyStore();

  // Estados locales de conteo
  const [countedInput, setCountedInput] = useState<string>('');
  const [salesInput, setSalesInput] = useState<string>('0');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [toast, setToast] = useState<{
    text: string;
    type: 'success' | 'warning' | 'error';
    discrepancyVal?: number;
  } | null>(null);

  // Referencias para auto-enfoque en colector
  const scannerInputRef = useRef<HTMLInputElement>(null);
  const countInputRef = useRef<HTMLInputElement>(null);

  // Auto-enfocar el campo de escaneo al montar el componente
  useEffect(() => {
    scannerInputRef.current?.focus();
  }, []);

  // Cuando cambia la tarea activa, sincronizar los inputs
  useEffect(() => {
    if (activeTask) {
      const existingCount =
        activeTask.CountedQuantity !== null && activeTask.CountedQuantity !== undefined
          ? String(activeTask.CountedQuantity)
          : '';
      setCountedInput(existingCount);
      setSalesInput(String(activeTask.SalesDuringAudit || 0));

      // Enfocar directamente el campo de conteo físico para agilizar operación
      setTimeout(() => {
        countInputRef.current?.focus();
        countInputRef.current?.select();
      }, 50);
    } else {
      setCountedInput('');
      setSalesInput('0');
    }
  }, [activeTask]);

  // Manejador de búsqueda / escaneo de SKU con regla LPAD 6 dígitos
  const handleBarcodeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const query = (searchTerm || '').trim();
    if (!query) return;

    const task = setActiveTaskBySku(query);
    if (!task) {
      showToastBanner(`No se encontró el SKU o código "${query}" en esta misión`, 'warning');
      scannerInputRef.current?.focus();
      scannerInputRef.current?.select();
    } else {
      showToastBanner(`SKU ${task.SkuCode} cargado`, 'success');
    }
  };

  // Botones de ajuste rápido táctil (+1, +5, +10, -1, reset)
  const adjustCount = (delta: number) => {
    const current = parseFloat(countedInput) || 0;
    const nextVal = Math.max(0, current + delta);
    setCountedInput(String(nextVal));
  };

  // Cálculos en tiempo real del modelo teórico
  const systemQty = Number(activeTask?.SystemQuantity ?? 0);
  const salesQty = parseFloat(salesInput) || 0;
  const adjustedTheoretical = systemQty - salesQty;
  const countedQty = parseFloat(countedInput);
  const isCountValid = !isNaN(countedQty) && countedQty >= 0;
  const liveDiscrepancy = isCountValid ? countedQty - adjustedTheoretical : 0;
  const isExactMatch = isCountValid && liveDiscrepancy === 0;

  // Registrar conteo físico (Estrategia Online con Fallback a IndexedDB)
  const handleRegisterCount = async () => {
    if (!activeTask) return;

    if (!isCountValid) {
      showToastBanner('Ingrese una cantidad válida mayor o igual a cero', 'error');
      countInputRef.current?.focus();
      return;
    }

    setIsSubmitting(true);
    const discrepancy = Number((countedQty - adjustedTheoretical).toFixed(2));
    const taskStatus = discrepancy === 0 ? 'COMPLETED_MATCH' : 'DISCREPANT';

    // 1. Actualización optimista local en memoria
    updateTaskCountLocally(activeTask.SkuCode, countedQty, salesQty, discrepancy, taskStatus);

    // 2. Si se detecta faltante/sobrante, preparar registro en cola de piso
    if (discrepancy !== 0) {
      const discItem: FloorDiscrepancy = {
        DiscrepancyId: crypto.randomUUID ? crypto.randomUUID() : `disc_${Date.now()}`,
        TaskId: activeTask.TaskId,
        MissionId: activeMissionId || activeTask.MissionId,
        SkuCode: activeTask.SkuCode,
        SkuDescription: activeTask.SkuDescription,
        MissingQuantity: discrepancy,
        OriginDeposit: activeTask.DepositCode || '150101',
        FloorDeposit: '150103',
        WarehouseDiscrepancy: discrepancy,
        FloorSystemQuantity: 0,
        FloorCountedQuantity: null,
        FloorDiscrepancy: null,
        Status: 'PENDING_FLOOR_COUNT',
        ResolvedAt: null,
      };
      addDiscrepancy(discItem);
    }

    // 3. Payload oficial para backend / EventStore
    const payload = {
      mission_id: activeMissionId || activeTask.MissionId,
      task_id: activeTask.TaskId,
      deposit_code: activeTask.DepositCode || '150101',
      sku_code: activeTask.SkuCode,
      counted_quantity: countedQty,
      sales_during_audit: salesQty,
    };

    // 4. Estrategia de Envío Online / Offline
    try {
      if (isOnline && isSupabaseConfigured) {
        // Intento directo a Edge Function
        const { error } = await supabase.functions.invoke('register-count', {
          body: payload,
        });

        if (error) {
          console.warn('[TabCollector] Edge Function falló, persistiendo en tabla Read_Mission_Tasks:', error);
          // Fallback directo a PostgreSQL
          await supabase
            .from('Read_Mission_Tasks')
            .update({
              CountedQuantity: countedQty,
              SalesDuringAudit: salesQty,
              Discrepancy: discrepancy,
              Status: taskStatus,
              UpdatedAt: new Date().toISOString(),
            })
            .eq('TaskId', activeTask.TaskId);

          if (discrepancy !== 0) {
            await supabase.from('Read_Floor_Discrepancies').insert({
              MissionId: activeMissionId || activeTask.MissionId,
              TaskId: activeTask.TaskId,
              OriginDeposit: activeTask.DepositCode || '150101',
              FloorDeposit: '150103',
              SkuCode: activeTask.SkuCode,
              SkuDescription: activeTask.SkuDescription,
              WarehouseDiscrepancy: discrepancy,
              Status: 'PENDING_FLOOR_COUNT',
            });
          }
        }
      } else {
        // Modo Offline o sin credenciales: almacenar en cola IndexedDB AuditDB
        await enqueueOfflineEvent({
          type: 'register-count',
          missionId: activeMissionId || activeTask.MissionId,
          taskId: activeTask.TaskId,
          payload,
        });
      }
    } catch (err) {
      console.warn('[TabCollector] Error de red al registrar conteo, encolando offline:', err);
      await enqueueOfflineEvent({
        type: 'register-count',
        missionId: activeMissionId || activeTask.MissionId,
        taskId: activeTask.TaskId,
        payload,
      });
    } finally {
      setIsSubmitting(false);

      // Feedback al auditor
      if (discrepancy === 0) {
        showToastBanner(`Conteo exacto registrado (${countedQty} u)`, 'success');
      } else {
        showToastBanner(
          `Discrepancia de ${discrepancy > 0 ? `+${discrepancy}` : discrepancy} registrada. Enviada a Piso (150103)`,
          'warning',
          discrepancy
        );
      }

      // Limpiar y preparar inmediatamente para el siguiente escaneo
      clearActiveTask();
      setCountedInput('');
      setSalesInput('0');
      setSearchTerm('');
      setTimeout(() => {
        scannerInputRef.current?.focus();
      }, 50);
    }
  };

  const showToastBanner = (text: string, type: 'success' | 'warning' | 'error', discrepancyVal?: number) => {
    setToast({ text, type, discrepancyVal });
    setTimeout(() => {
      setToast(null);
    }, 4500);
  };

  return (
    <div className="space-y-4 max-w-4xl mx-auto w-full">
      {/* 1. BUSCADOR / ESCÁNER PROMINENTE (Con regla LPAD 6 dígitos) */}
      <div className="bg-slate-800 border-2 border-slate-700 focus-within:border-blue-500 rounded-2xl p-3 sm:p-4 shadow-xl transition">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs sm:text-sm font-black text-slate-200 uppercase tracking-wider flex items-center gap-2">
            <Barcode className="w-5 h-5 text-blue-400" />
            <span>Escaneo / Búsqueda de SKU (Regla LPAD 6 Dígitos)</span>
          </label>
          <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400">
            {isOnline ? (
              <span className="flex items-center gap-1 text-emerald-400">
                <Wifi className="w-3.5 h-3.5" /> En línea
              </span>
            ) : (
              <span className="flex items-center gap-1 text-amber-400">
                <WifiOff className="w-3.5 h-3.5" /> Modo Offline
              </span>
            )}
          </div>
        </div>

        <form onSubmit={handleBarcodeSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-5 h-5 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={scannerInputRef}
              type="text"
              inputMode="text"
              autoComplete="off"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Escanear código de barras o ingresar SKU (ej: 42419)..."
              className="w-full h-14 pl-11 pr-10 bg-slate-900 border-2 border-slate-700 focus:border-blue-500 rounded-xl text-white font-mono text-lg font-bold placeholder:text-slate-500 focus:outline-hidden"
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => {
                  setSearchTerm('');
                  scannerInputRef.current?.focus();
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          <button
            type="submit"
            className="btn-collector bg-blue-600 hover:bg-blue-500 text-white min-h-[56px] min-w-[56px] px-5 sm:px-6 rounded-xl font-bold flex items-center gap-2 shadow-lg shadow-blue-600/20 active:scale-95 transition"
          >
            <Search className="w-5 h-5" />
            <span className="hidden sm:inline">Buscar</span>
          </button>
        </form>

        {/* Guía LPAD contextual */}
        {searchTerm && /^\d{1,5}$/.test(searchTerm.trim()) && (
          <p className="mt-2 text-xs font-mono text-blue-300 flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-blue-400" />
            Auto-formateo LPAD: <strong>"{searchTerm.trim()}"</strong> &rarr;{' '}
            <strong className="underline">{normalizeSku(searchTerm)}</strong>
          </p>
        )}
      </div>

      {/* 2. FORMULARIO TÁCTIL DE CONTEO */}
      {activeTask ? (
        <div className="bg-slate-800/95 border-2 border-blue-500/80 rounded-2xl p-4 sm:p-6 shadow-2xl space-y-5 animate-fadeIn">
          {/* Cabecera del Artículo */}
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 pb-4 border-b border-slate-700/80">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-mono font-black bg-blue-950 text-blue-300 px-3 py-1 rounded-lg border border-blue-800">
                  SKU: {activeTask.SkuCode}
                </span>
                <span className="text-xs font-semibold text-slate-400">
                  Depósito {activeTask.DepositCode || '150101'}
                </span>
                <span className="text-xs font-semibold text-slate-400">
                  Costo: ${Number(activeTask.Cost || 0).toFixed(2)}
                </span>
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-white mt-1.5 tracking-tight">
                {activeTask.SkuDescription}
              </h2>

              {/* Lista de Códigos de Barra asociados */}
              {activeTask.Barcodes && activeTask.Barcodes.length > 0 && (
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="text-[11px] text-slate-400 font-semibold uppercase">EAN/UPC:</span>
                  {activeTask.Barcodes.map((bc, idx) => (
                    <span
                      key={idx}
                      className="text-xs font-mono bg-slate-900 text-slate-300 px-2 py-0.5 rounded border border-slate-700"
                    >
                      {bc}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <button
              onClick={clearActiveTask}
              className="self-start sm:self-auto p-2 bg-slate-700/60 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition"
            >
              <X className="w-4 h-4" />
              <span>Cerrar</span>
            </button>
          </div>

          {/* Grid de Ecuación Teórica de Inventario (S, V, S - V) */}
          <div className="grid grid-cols-3 gap-2.5 sm:gap-3 bg-slate-950/80 p-3 sm:p-4 rounded-xl border border-slate-700/80 text-center">
            <div className="p-2 bg-slate-900/60 rounded-lg">
              <span className="text-[10px] sm:text-xs text-slate-400 uppercase font-black block tracking-wider">
                Sistema (S)
              </span>
              <span className="text-xl sm:text-2xl font-black text-white font-mono mt-1 block">
                {systemQty.toFixed(2)}
              </span>
              <span className="text-[10px] text-slate-500">Unidades base</span>
            </div>

            <div className="p-2 bg-slate-900/60 rounded-lg">
              <span className="text-[10px] sm:text-xs text-amber-400 uppercase font-black block tracking-wider">
                Ventas Hoy (V)
              </span>
              <span className="text-xl sm:text-2xl font-black text-amber-300 font-mono mt-1 block">
                {salesQty.toFixed(2)}
              </span>
              <span className="text-[10px] text-amber-500/80">Facturadas</span>
            </div>

            <div className="p-2 bg-slate-900/60 rounded-lg border border-blue-500/30">
              <span className="text-[10px] sm:text-xs text-blue-400 uppercase font-black block tracking-wider">
                Teórico (S - V)
              </span>
              <span className="text-xl sm:text-2xl font-black text-blue-300 font-mono mt-1 block">
                {adjustedTheoretical.toFixed(2)}
              </span>
              <span className="text-[10px] text-blue-400/70">Ajustado</span>
            </div>
          </div>

          {/* Campo Numérico Gigante para "Cantidad Contada Físicamente" */}
          <div className="space-y-2">
            <label className="text-xs sm:text-sm font-black text-slate-200 uppercase tracking-wider flex items-center justify-between">
              <span>CANTIDAD CONTADA FÍSICAMENTE (Qc)</span>
              <span className="text-xs text-emerald-400 font-bold">Campo obligatorio</span>
            </label>

            <div className="relative">
              <input
                ref={countInputRef}
                type="number"
                step="any"
                min="0"
                value={countedInput}
                onChange={(e) => setCountedInput(e.target.value)}
                placeholder="0.00"
                className="w-full h-20 sm:h-24 px-4 bg-slate-950 border-3 border-emerald-500/70 focus:border-emerald-400 rounded-2xl text-white font-mono text-3xl sm:text-5xl font-black text-center shadow-inner focus:outline-hidden"
              />
            </div>

            {/* Teclado de Incrementos Rápidos Táctiles (Mínimo 48px por botón) */}
            <div className="grid grid-cols-6 gap-2 pt-1">
              <button
                type="button"
                onClick={() => adjustCount(1)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                +1
              </button>
              <button
                type="button"
                onClick={() => adjustCount(5)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                +5
              </button>
              <button
                type="button"
                onClick={() => adjustCount(10)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                +10
              </button>
              <button
                type="button"
                onClick={() => adjustCount(25)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                +25
              </button>
              <button
                type="button"
                onClick={() => adjustCount(-1)}
                className="btn-collector bg-slate-700 hover:bg-slate-600 text-white min-h-[48px] rounded-xl font-black text-base active:scale-95"
              >
                -1
              </button>
              <button
                type="button"
                onClick={() => setCountedInput('')}
                className="btn-collector bg-rose-950/80 hover:bg-rose-900 border border-rose-700 text-rose-300 min-h-[48px] rounded-xl font-bold text-xs active:scale-95"
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Campo de Ventas Durante Auditoría */}
          <div>
            <label className="block text-xs font-bold text-slate-300 mb-1.5 flex items-center justify-between">
              <span>VENTAS REGISTRADAS DURANTE LA AUDITORÍA:</span>
              <span className="text-[11px] text-amber-400 font-normal">Resta al inventario del sistema</span>
            </label>
            <input
              type="number"
              step="any"
              min="0"
              value={salesInput}
              onChange={(e) => setSalesInput(e.target.value)}
              className="w-full h-12 px-4 bg-slate-900 border border-slate-700 rounded-xl text-amber-300 font-mono text-xl font-black text-center focus:outline-hidden focus:border-amber-500"
            />
          </div>

          {/* Banner de Previsualización Dinámica del Resultado */}
          {isCountValid && (
            <div
              className={`p-4 rounded-xl border-2 flex items-center justify-between transition ${
                isExactMatch
                  ? 'bg-emerald-950/70 border-emerald-500 text-emerald-200'
                  : 'bg-amber-950/70 border-amber-500 text-amber-200'
              }`}
            >
              <div className="flex items-center gap-2.5">
                {isExactMatch ? (
                  <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" />
                ) : (
                  <AlertTriangle className="w-6 h-6 text-amber-400 shrink-0" />
                )}
                <div>
                  <span className="text-xs uppercase font-bold tracking-wider block">
                    {isExactMatch ? 'Coincidencia Exacta' : 'Discrepancia Calculada'}
                  </span>
                  <span className="text-sm font-semibold">
                    {isExactMatch
                      ? 'El conteo físico coincide al 100% con el teórico ajustado.'
                      : liveDiscrepancy < 0
                      ? `Faltante de ${Math.abs(liveDiscrepancy).toFixed(2)} unidades en almacén.`
                      : `Sobrante de ${liveDiscrepancy.toFixed(2)} unidades en almacén.`}
                  </span>
                </div>
              </div>

              <div className="text-right pl-3 shrink-0">
                <span className="font-mono text-2xl font-black">
                  {liveDiscrepancy > 0 ? `+${liveDiscrepancy.toFixed(2)}` : liveDiscrepancy.toFixed(2)}
                </span>
                <span className="text-[10px] block uppercase font-bold text-slate-400">Diferencia</span>
              </div>
            </div>
          )}

          {/* BOTÓN DE GUARDADO RÁPIDO "REGISTRAR CONTEO" (Mínimo 56px de alto) */}
          <button
            onClick={handleRegisterCount}
            disabled={!isCountValid || isSubmitting}
            className="w-full min-h-[58px] bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:pointer-events-none active:scale-[0.98] text-white font-black text-lg sm:text-xl rounded-2xl shadow-xl shadow-emerald-700/30 flex items-center justify-center gap-3 transition touch-manipulation"
          >
            <CheckCircle2 className="w-6 h-6" />
            <span>{isSubmitting ? 'REGISTRANDO...' : 'REGISTRAR CONTEO'}</span>
          </button>
        </div>
      ) : (
        /* Estado Vacío - Esperando Escaneo */
        <div className="bg-slate-800/40 border-2 border-dashed border-slate-700 rounded-2xl p-8 sm:p-12 text-center text-slate-400 space-y-3">
          <div className="w-16 h-16 rounded-2xl bg-blue-600/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mx-auto">
            <Barcode className="w-9 h-9" />
          </div>
          <h3 className="text-lg font-bold text-slate-200">Listo para escanear en Almacén</h3>
          <p className="text-xs sm:text-sm text-slate-400 max-w-md mx-auto leading-relaxed">
            Apunte el colector hacia el código de barras del producto o escriba el código SKU en la barra superior.
          </p>

          {/* Acceso Rápido a Tareas Pendientes si existen */}
          {tasks.length > 0 && (
            <div className="pt-4 border-t border-slate-800 text-left max-w-lg mx-auto">
              <span className="text-[11px] font-bold text-slate-400 uppercase tracking-wider block mb-2">
                Últimos SKUs pendientes en la misión:
              </span>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto custom-scrollbar">
                {tasks
                  .filter((t) => t.CountedQuantity === null || t.CountedQuantity === undefined)
                  .slice(0, 8)
                  .map((t) => (
                    <button
                      key={t.TaskId || t.taskId}
                      onClick={() => setActiveTaskBySku(t.SkuCode || t.skuCode || '')}
                      className="text-xs font-mono bg-slate-900 hover:bg-blue-900/60 border border-slate-700 hover:border-blue-500 text-slate-300 hover:text-white px-2.5 py-1.5 rounded-lg transition"
                    >
                      {t.SkuCode || t.skuCode}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TOAST FLOTANTE NO BLOQUEANTE */}
      {toast && (
        <div
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-3.5 rounded-2xl shadow-2xl text-xs sm:text-sm font-bold flex items-center justify-between gap-3 max-w-md w-[92%] border backdrop-blur-md animate-slideUp ${
            toast.type === 'success'
              ? 'bg-emerald-950/90 border-emerald-500 text-emerald-200'
              : toast.type === 'warning'
              ? 'bg-amber-950/90 border-amber-500 text-amber-200'
              : 'bg-rose-950/90 border-rose-500 text-rose-200'
          }`}
        >
          <div className="flex items-center gap-2.5">
            {toast.type === 'success' && <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />}
            {toast.type === 'warning' && <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />}
            {toast.type === 'error' && <X className="w-5 h-5 text-rose-400 shrink-0" />}
            <span>{toast.text}</span>
          </div>

          {toast.discrepancyVal !== undefined && onNavigateToFloor && (
            <button
              onClick={onNavigateToFloor}
              className="underline text-[11px] font-black text-amber-300 hover:text-white shrink-0 ml-2"
            >
              Ir a Piso &rarr;
            </button>
          )}
        </div>
      )}
    </div>
  );
};
