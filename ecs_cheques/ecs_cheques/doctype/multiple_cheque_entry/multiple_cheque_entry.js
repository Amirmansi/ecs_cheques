// Copyright (c) 2021, erpcloud.systems and contributors
// For license information, please see license.txt

/*****************************
 *  Helpers (async utilities)
 *****************************/
const get_mop_default_account = async (mode_of_payment, company) => {
    if (!mode_of_payment || !company) return null;
    const r = await frappe.call({
        method: "frappe.client.get_value",
        args: {
            doctype: "Mode of Payment Account",
            filters: { parent: mode_of_payment, company },
            fieldname: "default_account",
        },
    });
    return r?.message?.default_account || null;
};

const get_party_account = async (party_type, party, company) => {
    if (!party_type || !party || !company) return null;
    // ERPNext official helper: returns the receivable/payable account for party+company
    const r = await frappe.call({
        method: "erpnext.accounts.party.get_party_account",
        args: { party_type, party, company },
    });
    return r?.message || null;
};

const ensure_or_throw = (obj, keys, label = "Missing fields") => {
    const missing = keys.filter(k => !obj[k]);
    if (missing.length) {
        frappe.throw(`${label}: ${missing.join(", ")}`);
    }
};

const insert_and_submit_payment_entry = async (doc_to_insert) => {
    const ins = await frappe.call({
        method: "frappe.client.insert",
        args: { doc: doc_to_insert },
    });
    const submitted = await frappe.call({
        method: "frappe.client.submit",
        args: { doc: ins.message },
    });
    return submitted?.message?.name;
};

/*******************************************
 *  Queries / Filters (setup-time behavior)
 *******************************************/
frappe.ui.form.on("Multiple Cheque Entry", {
    setup: function (frm) {
        // فلترة الحساب البنكي حسب البنك المختار
        frm.set_query("bank_acc", function () {
            return {
                filters: [["Bank Account", "bank", "in", frm.doc.cheque_bank]],
            };
        });

        // فلترة البنوك الرئيسية فقط
        frm.set_query("cheque_bank", function () {
            return {
                filters: [["Bank", "company_bank", "=", "1"]],
            };
        });

        // فلترة حقول الجداول (طرق الدفع = Cheque) و party_type = Customer/Supplier
        ["cheque_table", "cheque_table_2"].forEach((table) => {
            if (frm.fields_dict[table]?.grid) {
                frm.fields_dict[table].grid
                    .get_field("mode_of_payment")
                    .get_query = function () {
                    return { filters: [["Mode of Payment", "type", "=", "Cheque"]] };
                };
                frm.fields_dict[table].grid.get_field("party_type").get_query =
                    function () {
                        return {
                            filters: [["DocType", "name", "in", ["Customer", "Supplier"]]],
                        };
                    };
            }
        });
    },
});

/*************************************
 *  Reactive field behaviors (header)
 *************************************/
frappe.ui.form.on("Multiple Cheque Entry", "party_type", function (frm) {
    frm.set_value("party", "");
    frm.set_value("party_name", "");
});

frappe.ui.form.on("Multiple Cheque Entry", "cheque_bank", function (frm) {
    frm.set_value("bank_acc", "");
    frm.set_value("account", "");
    frm.set_value("collection_fee_account", "");
    frm.set_value("payable_account", "");
});

frappe.ui.form.on("Multiple Cheque Entry", "bank_acc", function (frm) {
    frm.set_value("account", "");
    frm.set_value("collection_fee_account", "");
    frm.set_value("payable_account", "");
});

// تحديد party_type تلقائيًا حسب نوع الدفع
frappe.ui.form.on("Multiple Cheque Entry", "payment_type", function (frm) {
    if (frm.doc.payment_type === "Receive") {
        frm.set_value("party_type", "Customer");
    }
    if (frm.doc.payment_type === "Pay") {
        frm.set_value("party_type", "Supplier");
    }
});

// جلب party_name تلقائيًا من الـ Party
frappe.ui.form.on("Multiple Cheque Entry", "party", function (frm) {
    if (!frm.doc.party_type || !frm.doc.party) return;
    if (frm.doc.party_type === "Customer") {
        frappe.call({
            method: "frappe.client.get_value",
            args: {
                doctype: "Customer",
                fieldname: "customer_name",
                filters: { name: frm.doc.party },
            },
            callback: function (r) {
                frm.set_value("party_name", r?.message?.customer_name || "");
            },
        });
    } else if (frm.doc.party_type === "Supplier") {
        frappe.call({
            method: "frappe.client.get_value",
            args: {
                doctype: "Supplier",
                fieldname: "supplier_name",
                filters: { name: frm.doc.party },
            },
            callback: function (r) {
                frm.set_value("party_name", r?.message?.supplier_name || "");
            },
        });
    }
});

/*************************
 *  Validation (header)
 *************************/
frappe.ui.form.on("Multiple Cheque Entry", "validate", function (frm) {
    if (frm.doc.mode_of_payment_type && frm.doc.mode_of_payment_type !== "Cheque") {
        frappe.throw(
            "نوع طريقة الدفع المختارة ليس شيك ... برجاء اختيار طريقة دفع من نوع شيك."
        );
    }
});

/***************************************
 *  On Submit: Create Payment Entries
 ***************************************/
frappe.ui.form.on("Multiple Cheque Entry", "on_submit", async function (frm) {
    // يعمل لكلا الحالتين؛ سنحدد الجدول واتجاه الحسابات حسب نوع الدفع
    const isReceive = frm.doc.payment_type === "Receive";
    const isPay = frm.doc.payment_type === "Pay";
    if (!isReceive && !isPay) return;

    // اختيار الجدول والـ child doctype المراد تحديثه
    const table_field = isReceive ? "cheque_table" : "cheque_table_2";
    const child_doctype = isReceive ? "Cheque Table Receive" : "Cheque Table Pay";

    const rows = frm.doc[table_field] || [];
    if (!rows.length) return;

    // تحقق من رؤوس أساسية
    ensure_or_throw(
        frm.doc,
        ["company", "posting_date", "payment_type", "party_type", "party"],
        "حقول رئيسية ناقصة"
    );

    // الحصول على حساب الطرف (Receivable/Payable) لطرف المعاملة
    const party_account = await get_party_account(
        frm.doc.party_type,
        frm.doc.party,
        frm.doc.company
    );

    // لو فشل جلب حساب الطرف، نوقف قبل الإنشاء (أفضل من أن يفشل داخل insert)
    if (!party_account) {
        frappe.throw(
            "تعذر جلب حساب الطرف تلقائيًا. برجاء ضبط إعدادات حسابات العملاء/الموردين للشركة."
        );
    }

    // سنقوم بالإنشاء بشكل متسلسل لضمان اكتمال كل إدخال وتحديث الربط
    let created_count = 0;

    for (const row of rows) {
        if (row.payment_entry) continue; // متقفّل بالفعل

        // جلب حساب البنك/النقدية من Mode of Payment Account الخاصة بسطر الشيك
        const mop_account = await get_mop_default_account(
            row.mode_of_payment,
            frm.doc.company
        );

        if (!mop_account) {
            frappe.throw(
                `لا يوجد Default Account لِـ Mode of Payment "${row.mode_of_payment}" على شركة "${frm.doc.company}".`
            );
        }

        // تحديد جهتي القيد حسب نوع العملية:
        // Receive: paid_from = party_account (Receivable) , paid_to = mop_account (Bank/Cash)
        // Pay:     paid_from = mop_account (Bank/Cash)     , paid_to = party_account (Payable)
        const paid_from = isReceive ? party_account : mop_account;
        const paid_to = isReceive ? mop_account : party_account;

        // تحقق أساسي قبل الإدراج
        ensure_or_throw(
            {
                paid_from,
                paid_to,
                mode_of_payment: row.mode_of_payment,
                party_type: row.party_type || frm.doc.party_type,
                party: row.party || frm.doc.party,
                paid_amount: row.paid_amount,
            },
            ["paid_from", "paid_to", "mode_of_payment", "party_type", "party", "paid_amount"],
            "بيانات ناقصة لإنشاء Payment Entry"
        );

        // تجهيز مستند الدفع
        const pe_doc = {
            doctype: "Payment Entry",
            posting_date: frm.doc.posting_date,
            company: frm.doc.company,
            payment_type: frm.doc.payment_type,
            // ربط مرجعي
            reference_doctype: "Multiple Cheque Entry",
            reference_link: frm.doc.name,

            // التعريفات المالية
            mode_of_payment: row.mode_of_payment,
            mode_of_payment_type: row.mode_of_payment_type || "Cheque",

            party_type: row.party_type || frm.doc.party_type,
            party: row.party || frm.doc.party,

            paid_from: paid_from,
            paid_to: paid_to,

            // قيم المبلغ
            paid_amount: row.paid_amount,
            received_amount: row.paid_amount,

            // بيانات الشيك
            cheque_type: row.cheque_type,
            reference_no: row.reference_no,
            reference_date: row.reference_date,
            drawn_bank: row.bank || frm.doc.cheque_bank,
            bank_acc: frm.doc.bank_acc, // إن كان لديكم حقل مخصص في PE
            first_beneficiary: row.first_beneficiary,
            person_name: row.person_name,
            issuer_name: row.issuer_name,
            picture_of_check: row.picture_of_check,

            // ربط رقم السطر للرجوع له لاحقًا
            cheque_table_no: isReceive ? row.name : undefined,
            cheque_table_no2: isPay ? row.name : undefined,
        };

        // الإنشاء ثم التقديم
        const pe_name = await insert_and_submit_payment_entry(pe_doc);

        // تحديث السطر بالـ payment_entry
        if (pe_name) {
            await frappe.db.set_value(child_doctype, row.name, "payment_entry", pe_name);
            created_count++;
        }
    }

    if (created_count > 0) {
        frappe.msgprint(
            `تم إنشاء ${created_count} سند/سندات دفع بنجاح. برجاء مراجعة المدفوعات والمقبوضات.`
        );
        frm.reload_doc();
    }
});

/********************************************
 *  Child rows reactive: first_beneficiary
 ********************************************/
frappe.ui.form.on("Cheque Table Pay", "first_beneficiary", function (frm) {
    if (!frm.doc.cheque_table_2) return;
    for (let i = 0; i < frm.doc.cheque_table_2.length; i++) {
        frm.doc.cheque_table_2[i].person_name = frm.doc.party_name;
        frm.doc.cheque_table_2[i].issuer_name = frm.doc.company;
    }
    frm.refresh_field("cheque_table_2");
});

frappe.ui.form.on("Cheque Table Receive", "first_beneficiary", function (frm) {
    if (!frm.doc.cheque_table) return;
    for (let i = 0; i < frm.doc.cheque_table.length; i++) {
        frm.doc.cheque_table[i].person_name = frm.doc.company;
        frm.doc.cheque_table[i].issuer_name = frm.doc.party_name;
    }
    frm.refresh_field("cheque_table");
});
