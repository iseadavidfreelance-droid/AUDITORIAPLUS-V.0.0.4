/**
 * AUDITORIAPLUS+ - Tab Ingesta de Misiones y Dashboard de Auditorías
 * Carga directa de archivos Excel/CSV hacia Supabase Edge Function 'ingest-excel'.
 * Lectura en tiempo real de Read_Missions y selección de misión activa.
 * REGLA DE ORO: Cero datos mock o simulados. Conexión 100% real a PostgreSQL.
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  UploadCloud,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Layers,
  Calendar,
  ShieldCheck,
  ArrowRight,
  Hash,
  Database,
  Check,
  AlertCircle
} from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useMissionStore } from '../store/useMissionStore';
import { DepositCode, DEPOSIT_NAMES } from '../types/audit';

interface MissionRecord {
  MissionId: string;
  Name?: string;
  MissionName?: string;
  DepositCode: string;
  ExcelHashSHA256?: string;
  ExcelHash?: string;
  Status: string;
  TotalSkus?: number;
  TotalTasks?: number;
  CountedSkus?: number;
  CompletedTasks?: number;
  PendingSkus?: number;
  DiscrepantSkus?: number;
  ReconciledSkus?: number;
  ReconciledTasks?: number;
  CreatedAt: string;
  UpdatedAt?: string;
}

interface TabIngestionProps {
  onMissionSelected?: (missionId: string) => void;
}

export const TabIngestion: React.FC<TabIngestionProps> = ({ onMissionSelected }) => {
  const {
    activeMissionId,
    setActiveMissionId,
    fetchMissionTasks,
    setActiveMission,
    isOnline,
  } = useMissionStore();

  // Estados de Ingesta
  const [file, setFile] = useState<File | null>(null);
  const [missionName, setMissionName] = useState<string>('');
  const [depositCode, setDepositCode] = useState<DepositCode>('150101');
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [uploadResult, setUploadResult] = useState<{
    success: boolean;
    hash?: string;
    missionId?: string;
    totalTasks?: number;
    error?: string;
  } | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);

  // Estados de Listado de Misiones
  const [missions, setMissions] = useState<MissionRecord[]>([]);
  const [isLoadingMissions, setIsLoadingMissions] = useState<boolean>(false);
  const [missionsError, setMissionsError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // 1. Cargar misiones reales desde Read_Missions en Supabase
  const loadMissions = async () => {
    if (!isSupabaseConfigured) {
      setMissionsError('Supabase no está configurado. Configure VITE_SUPABASE_URL y VITE_SUPABASE_ANON_KEY en su archivo de entorno.');
      return;
    }

    setIsLoadingMissions(true);
    setMissionsError(null);

    try {
      const { data, error } = await supabase
        .from('Read_Missions')
        .select('*')
        .order('CreatedAt', { ascending: false });

      if (error) {
        console.error('[TabIngestion] Error al consultar Read_Missions:', error);
        setMissionsError(error.message);
        setMissions([]);
      } else if (data) {
        setMissions(data as MissionRecord[]);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[TabIngestion] Excepción al leer misiones:', msg);
      setMissionsError(msg);
      setMissions([]);
    } finally {
      setIsLoadingMissions(false);
    }
  };

  useEffect(() => {
    loadMissions();
  }, [isOnline]);

  // Manejo de drag & drop
  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true);
    } else if (e.type === 'dragleave') {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelected(e.dataTransfer.files[0]);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelected(e.target.files[0]);
    }
  };

  const handleFileSelected = (selectedFile: File) => {
    const validExtensions = ['.xlsx', '.xls', '.csv'];
    const hasValidExt = validExtensions.some((ext) =>
      selectedFile.name.toLowerCase().endsWith(ext)
    );

    if (!hasValidExt) {
      setUploadResult({
        success: false,
        error: 'Formato no soportado. Seleccione un archivo Excel (.xlsx, .xls) o CSV (.csv).',
      });
      return;
    }

    setFile(selectedFile);
    setUploadResult(null);

    // Sugerir nombre de misión a partir del archivo si está vacío
    if (!missionName) {
      const nameWithoutExt = selectedFile.name.replace(/\.[^/.]+$/, '').replace(/[_-]/g, ' ');
      setMissionName(`Auditoría ${nameWithoutExt}`);
    }
  };

  // 2. Envío a la Edge Function 'ingest-excel'
  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      setUploadResult({
        success: false,
        error: 'Debe seleccionar un archivo para iniciar la ingesta.',
      });
      return;
    }

    if (!isSupabaseConfigured) {
      setUploadResult({
        success: false,
        error: 'Supabase no está configurado. No se puede invocar la Edge Function ingest-excel.',
      });
      return;
    }

    setIsUploading(true);
    setUploadResult(null);

    try {
      const formData = new FormData();
      formData.append('file_a', file);
      formData.append('deposit_code', depositCode);
      formData.append(
        'mission_name',
        missionName.trim() || `Auditoría ${new Date().toLocaleDateString('es-ES')}`
      );

      // Invocación a Supabase Edge Function ingest-excel
      const { data, error } = await supabase.functions.invoke('ingest-excel', {
        body: formData,
      });

      if (error) {
        const errorMsg =
          (error as { status?: number }).status === 409
            ? 'Conflicto (409): Este archivo ya ha sido ingerido previamente. El hash SHA-256 es idéntico a una misión existente.'
            : error.message || 'Error en la Edge Function ingest-excel.';

        setUploadResult({
          success: false,
          error: errorMsg,
        });
      } else {
        const hash = data?.excel_hash || data?.excel_hash_sha256 || data?.data?.excel_hash_sha256 || 'Calculado en backend';
        const newMissionId = data?.mission_id || data?.data?.mission_id;
        const total = data?.total_tasks || data?.data?.total_tasks || 0;

        setUploadResult({
          success: true,
          hash,
          missionId: newMissionId,
          totalTasks: total,
        });

        // Limpiar archivo seleccionado
        setFile(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }

        // Recargar misiones y seleccionar automáticamente si hay ID
        await loadMissions();
        if (newMissionId) {
          await handleSelectMission(newMissionId);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setUploadResult({
        success: false,
        error: `Fallo de conexión al enviar archivo: ${msg}`,
      });
    } finally {
      setIsUploading(false);
    }
  };

  // 3. Selección de Misión
  const handleSelectMission = async (missionId: string) => {
    setActiveMissionId(missionId);

    // Buscar en lista local
    const selected = missions.find((m) => m.MissionId === missionId);
    if (selected) {
      const total = Number(selected.TotalSkus || selected.TotalTasks || 0);
      const counted = Number(selected.CountedSkus || selected.CompletedTasks || 0);
      const pending = Number(selected.PendingSkus ?? Math.max(0, total - counted));
      const discrepant = Number(selected.DiscrepantSkus || 0);
      const reconciled = Number(selected.ReconciledSkus || selected.ReconciledTasks || 0);

      setActiveMission({
        missionId: selected.MissionId,
        name: selected.Name || selected.MissionName || `Misión ${selected.MissionId.slice(0, 8)}`,
        depositCode: (selected.DepositCode as DepositCode) || '150101',
        totalSkus: total,
        countedSkus: counted,
        pendingSkus: pending,
        discrepantSkus: discrepant,
        reconciledSkus: reconciled,
        totalCostDiscrepancy: 0,
        status: (selected.Status as 'IN_PROGRESS' | 'COMPLETED' | 'CLOSED') || 'IN_PROGRESS',
        createdAt: selected.CreatedAt,
      });
    }

    // Cargar tareas desde Supabase
    await fetchMissionTasks(missionId);

    if (onMissionSelected) {
      onMissionSelected(missionId);
    }
  };

  return (
    <div className="space-y-6">
      {/* SECCIÓN 1: FORMULARIO DE INGESTA DE ARCHIVOS (DROPZONE) */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-6 shadow-xl">
        <div className="flex items-center gap-3 pb-4 border-b border-slate-800">
          <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/40 text-blue-400 flex items-center justify-center shrink-0">
            <UploadCloud className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base sm:text-lg font-black text-white tracking-tight">
              Ingesta de Inventario (Excel / CSV)
            </h2>
            <p className="text-xs text-slate-400">
              Carga el catálogo de SKUs y existencias para procesar mediante la Edge Function <code>ingest-excel</code>
            </p>
          </div>
        </div>

        <form onSubmit={handleUpload} className="mt-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* Nombre de la Misión */}
            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1">
                Nombre de la Misión
              </label>
              <input
                type="text"
                value={missionName}
                onChange={(e) => setMissionName(e.target.value)}
                placeholder="Ej: Auditoría Almacén Q3 - Central"
                className="w-full h-11 px-3.5 bg-slate-950 border border-slate-700 rounded-lg text-white font-medium text-sm focus:outline-hidden focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                disabled={isUploading}
              />
            </div>

            {/* Selector de Depósito */}
            <div>
              <label className="block text-xs font-bold text-slate-300 uppercase tracking-wider mb-1">
                Depósito a Auditar
              </label>
              <select
                value={depositCode}
                onChange={(e) => setDepositCode(e.target.value as DepositCode)}
                className="w-full h-11 px-3 bg-slate-950 border border-slate-700 rounded-lg text-white font-medium text-sm focus:outline-hidden focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                disabled={isUploading}
              >
                <option value="150101">150101 - Almacén Principal (Reserva)</option>
                <option value="150103">150103 - Piso de Venta (Exhibición)</option>
                <option value="150102">150102 - Avería / Merma</option>
                <option value="150107">150107 - Galpón Secundario</option>
                <option value="150104">150104 - Tránsito Virtual</option>
              </select>
            </div>
          </div>

          {/* Área Dropzone */}
          <div
            onDragEnter={handleDrag}
            onDragLeave={handleDrag}
            onDragOver={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${
              dragActive
                ? 'border-blue-500 bg-blue-500/10'
                : file
                ? 'border-emerald-500/80 bg-emerald-950/20'
                : 'border-slate-700 hover:border-slate-600 bg-slate-950/60'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileChange}
              className="hidden"
              disabled={isUploading}
            />

            {file ? (
              <div className="flex flex-col items-center gap-2 text-emerald-400">
                <FileSpreadsheet className="w-10 h-10 text-emerald-400" />
                <span className="font-bold text-sm text-white">{file.name}</span>
                <span className="text-xs text-slate-400">
                  {(file.size / 1024).toFixed(1)} KB • Clic para cambiar archivo
                </span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-slate-400">
                <UploadCloud className="w-10 h-10 text-slate-500" />
                <p className="text-sm font-semibold text-slate-200">
                  Arrastra aquí tu archivo Excel o CSV, o haz clic para explorar
                </p>
                <p className="text-xs text-slate-500">
                  Formatos compatibles: .xlsx, .xls, .csv (Taxonomía, SKUs, Códigos de Barra y Stock)
                </p>
              </div>
            )}
          </div>

          {/* Feedback de Ingesta */}
          {uploadResult && (
            <div
              className={`p-3.5 rounded-xl border text-xs sm:text-sm font-medium ${
                uploadResult.success
                  ? 'bg-emerald-950/60 border-emerald-500 text-emerald-200'
                  : 'bg-rose-950/60 border-rose-500 text-rose-200'
              }`}
            >
              {uploadResult.success ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-bold text-emerald-300">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span>Misión creada e ingesta completada con éxito</span>
                  </div>
                  {uploadResult.hash && (
                    <div className="flex items-center gap-1.5 text-xs text-slate-300 font-mono break-all pt-1">
                      <Hash className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>SHA-256: {uploadResult.hash}</span>
                    </div>
                  )}
                  {uploadResult.missionId && (
                    <div className="text-xs text-slate-400 font-mono">
                      ID Misión: {uploadResult.missionId} • Tareas: {uploadResult.totalTasks || 'N/A'}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold block text-rose-300">Fallo en la ingesta</span>
                    <span>{uploadResult.error}</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Botón de Ingesta (min-h-[48px] táctil) */}
          <button
            type="submit"
            disabled={!file || isUploading}
            className="w-full btn-collector bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white min-h-[48px] rounded-xl font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20 transition"
          >
            {isUploading ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Procesando archivo y calculando SHA-256...</span>
              </>
            ) : (
              <>
                <UploadCloud className="w-4 h-4" />
                <span>Iniciar Ingesta en Supabase</span>
              </>
            )}
          </button>
        </form>
      </section>

      {/* SECCIÓN 2: LISTA DE MISIONES ACTIVAS Y SELECCIÓN */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 text-blue-400" />
            <h3 className="text-base font-black text-white">Misiones en la Base de Datos</h3>
            <span className="text-xs font-mono bg-slate-800 text-slate-300 px-2 py-0.5 rounded-full border border-slate-700">
              {missions.length}
            </span>
          </div>

          <button
            onClick={loadMissions}
            disabled={isLoadingMissions}
            className="p-2 text-xs font-bold text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg flex items-center gap-1.5 min-h-[38px] transition"
            title="Recargar misiones desde Supabase"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoadingMissions ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Actualizar</span>
          </button>
        </div>

        {/* Mensaje de Error de Conexión Real */}
        {missionsError && (
          <div className="bg-rose-950/40 border border-rose-800/80 p-3.5 rounded-xl text-xs text-rose-300 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-bold block">Error al consultar Read_Missions:</span>
              <span>{missionsError}</span>
            </div>
          </div>
        )}

        {/* Estado Vacío o Cargando */}
        {isLoadingMissions && missions.length === 0 ? (
          <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-8 text-center text-slate-400 space-y-2">
            <Loader2 className="w-8 h-8 mx-auto animate-spin text-blue-500" />
            <p className="text-sm font-semibold text-slate-200">Consultando Read_Missions en PostgreSQL...</p>
          </div>
        ) : missions.length === 0 ? (
          <div className="bg-slate-900/40 border-2 border-dashed border-slate-800 rounded-xl p-8 text-center text-slate-400 space-y-2">
            <Database className="w-10 h-10 mx-auto text-slate-600" />
            <h4 className="text-sm font-bold text-slate-300">No hay misiones registradas</h4>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              Utiliza el formulario superior para cargar el archivo Excel o CSV y desplegar la primera misión de auditoría.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {missions.map((mission) => {
              const isActive = activeMissionId === mission.MissionId;
              const totalSkus = Number(mission.TotalSkus || mission.TotalTasks || 0);
              const countedSkus = Number(mission.CountedSkus || mission.CompletedTasks || 0);
              const discrepantSkus = Number(mission.DiscrepantSkus || 0);
              const progress = totalSkus > 0 ? Math.min(100, Math.round((countedSkus / totalSkus) * 100)) : 0;
              const createdDate = new Date(mission.CreatedAt).toLocaleDateString('es-ES', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              });

              return (
                <div
                  key={mission.MissionId}
                  className={`bg-slate-900 border rounded-xl p-4 transition shadow-md flex flex-col justify-between gap-3 ${
                    isActive
                      ? 'border-blue-500 shadow-blue-500/10 ring-1 ring-blue-500'
                      : 'border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="space-y-2">
                    {/* Encabezado de la Tarjeta */}
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[10px] uppercase font-bold tracking-wider bg-slate-800 text-slate-300 px-2 py-0.5 rounded border border-slate-700">
                            {DEPOSIT_NAMES[mission.DepositCode as DepositCode] || `Depósito ${mission.DepositCode}`}
                          </span>
                          {isActive && (
                            <span className="text-[10px] uppercase font-black tracking-wider bg-blue-500/20 text-blue-400 px-2 py-0.5 rounded border border-blue-500/30 flex items-center gap-1">
                              <Check className="w-3 h-3" />
                              Activa
                            </span>
                          )}
                          <span
                            className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${
                              mission.Status === 'COMPLETED'
                                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                                : 'bg-amber-950 text-amber-400 border border-amber-800'
                            }`}
                          >
                            {mission.Status || 'IN_PROGRESS'}
                          </span>
                        </div>

                        <h4 className="text-base font-bold text-white mt-1.5 leading-snug">
                          {mission.Name || mission.MissionName || 'Auditoría General'}
                        </h4>
                      </div>
                    </div>

                    {/* Metadatos: ID y Fecha */}
                    <div className="text-[11px] text-slate-400 space-y-0.5">
                      <div className="flex items-center gap-1 font-mono text-[10px] text-slate-500 truncate">
                        <Hash className="w-3 h-3 shrink-0" />
                        <span>{mission.MissionId}</span>
                      </div>
                      <div className="flex items-center gap-1 text-slate-400">
                        <Calendar className="w-3 h-3 text-slate-500 shrink-0" />
                        <span>{createdDate}</span>
                      </div>
                    </div>

                    {/* Barra de Progreso y Métricas Rápidas */}
                    <div className="bg-slate-950/80 p-2.5 rounded-lg border border-slate-800/80 space-y-1.5">
                      <div className="flex justify-between text-xs font-semibold">
                        <span className="text-slate-400">Progreso de Conteo:</span>
                        <span className="font-mono text-white">
                          {countedSkus} / {totalSkus} SKUs ({progress}%)
                        </span>
                      </div>
                      <div className="w-full bg-slate-800 h-2 rounded-full overflow-hidden">
                        <div
                          className="bg-blue-500 h-full transition-all duration-300"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      {discrepantSkus > 0 && (
                        <div className="flex items-center gap-1 text-[11px] text-amber-400 font-semibold pt-0.5">
                          <AlertTriangle className="w-3 h-3 shrink-0" />
                          <span>{discrepantSkus} discrepancias detectadas</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Botón de Selección (min-h-[48px] táctil) */}
                  <button
                    onClick={() => handleSelectMission(mission.MissionId)}
                    disabled={isActive}
                    className={`btn-collector w-full min-h-[48px] rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition ${
                      isActive
                        ? 'bg-slate-800 text-slate-400 cursor-default border border-slate-700'
                        : 'bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/20 active:scale-[0.99]'
                    }`}
                  >
                    {isActive ? (
                      <>
                        <ShieldCheck className="w-4 h-4 text-emerald-400" />
                        <span>Misión Seleccionada</span>
                      </>
                    ) : (
                      <>
                        <span>Seleccionar Misión</span>
                        <ArrowRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
};

export default TabIngestion;
